import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { AGENTDEF_DIR } from './paths.js';
import { loadAgentManifest } from './loader.js';
import { parseIncludeList } from './install.js';
import { resolveIdentity } from './merge.js';
import { collectSkills } from './skills.js';
import { collectKnowledgeMetadata, renderKnowledgeIndex } from './knowledge.js';
// Model identifiers must be "provider:model" (e.g. anthropic:claude-opus-4-7).
// This is the exact rule the repurposed upstream package started enforcing, which
// broke CI; agentdef checks it explicitly.
const MODEL_RE = /^[a-z0-9-]+:.+$/;
export function validate(dir) {
    const agentDir = resolve(dir);
    const issues = [];
    let manifest;
    try {
        manifest = loadAgentManifest(agentDir);
    }
    catch (e) {
        return [{ level: 'error', message: e.message }];
    }
    if (!manifest.name) {
        issues.push({ level: 'error', message: 'agent.yaml: missing required field "name"' });
    }
    if (!manifest.description) {
        issues.push({ level: 'error', message: 'agent.yaml: missing required field "description"' });
    }
    const checkModel = (model, where) => {
        if (model && !MODEL_RE.test(model)) {
            issues.push({
                level: 'error',
                message: `agent.yaml: ${where} "${model}" must be "provider:model" (e.g. anthropic:claude-opus-4-7)`,
            });
        }
    };
    checkModel(manifest.model?.preferred, 'model.preferred');
    for (const fallback of manifest.model?.fallback ?? []) {
        checkModel(fallback, 'model.fallback');
    }
    // `include:` is applied on the CONSUMER, during their clone of this repo, so a
    // bad entry never fails here on its own. Checking it at the source is the only
    // place the person who can fix it will see it, before a push breaks every
    // downstream repo in an unattended git hook.
    try {
        const include = parseIncludeList(manifest.include, 'agent.yaml');
        for (const path of include ?? []) {
            const full = join(agentDir, path);
            if (!existsSync(full)) {
                // Cone mode silently ignores a pattern matching nothing, so a typo would
                // otherwise just quietly ship less than intended.
                issues.push({
                    level: 'warning',
                    message: `agent.yaml: include "${path}" does not exist here, so consumers will fetch nothing for it`,
                });
                continue;
            }
            // lstat, not stat: a symlink to a directory is not a directory to git
            // either. Cone mode takes directories only and exits 128 on anything else,
            // on the CONSUMER, so this must be an error here or the author ships a
            // value that breaks every downstream repo while their own CI stays green.
            if (!lstatSync(full).isDirectory()) {
                issues.push({
                    level: 'error',
                    message: `agent.yaml: include "${path}" is not a directory; sparse-checkout takes directories only, so this would fail every consumer's sync`,
                });
                continue;
            }
            // Cone mode selects a directory by also selecting each of its ancestors,
            // and an ancestor's own loose files come along with it. So `a/b` ships
            // every file sitting directly in `a/` too. Surprising precisely for the
            // repo that adopted include: to keep internal files out of consumers.
            const parent = dirname(path);
            if (parent !== '.') {
                const loose = readdirSync(join(agentDir, parent), { withFileTypes: true })
                    .filter((e) => e.isFile())
                    .map((e) => e.name);
                if (loose.length > 0) {
                    issues.push({
                        level: 'warning',
                        message: `agent.yaml: include "${path}" also ships the ${loose.length} file(s) directly in "${parent}/" (${loose.slice(0, 3).join(', ')}${loose.length > 3 ? ', ...' : ''}) — cone mode cannot select a subdirectory without its parent`,
                    });
                }
            }
        }
    }
    catch (e) {
        issues.push({ level: 'error', message: `agent.yaml: ${e.message}` });
    }
    // Chain-aware: a repo inheriting SOUL/RULES via extends is fine; only when the
    // whole chain resolves empty do adapters emit no identity (e.g. no Cursor
    // global rule), which would otherwise fail silently.
    const { soul, rules } = resolveIdentity(agentDir);
    if (!soul && !rules) {
        issues.push({
            level: 'warning',
            message: 'no SOUL.md or RULES.md found, neither locally nor via the extends chain. Adapters will generate no identity (Cursor: no global rule)',
        });
    }
    else if (!soul) {
        issues.push({ level: 'warning', message: 'no SOUL.md found, neither locally nor via the extends chain' });
    }
    // parseSkillMd throws on malformed frontmatter or missing name/description,
    // which surfaces here as an error rather than being silently skipped.
    //
    // Chain-wide, like the knowledge check below and unlike this check until now:
    // sync and every adapter read skills through collectSkills (local + parent +
    // deps), so a validate that looked only at the local skills/ reported green on
    // a chain sync then refused to build. It sees what is materialized, though: in
    // a checkout that never ran sync there is no .agentdef/parent and the chain
    // collapses back to the local directory.
    try {
        collectSkills(agentDir);
    }
    catch (e) {
        const message = e.message;
        issues.push({
            level: 'error',
            message: `skills: ${message}`,
            // Same reasoning as the knowledge hint: an inherited skill is not fixable
            // here, and saying so beats the reader editing a file under .agentdef/ that
            // the next sync overwrites.
            hint: message.includes(`${AGENTDEF_DIR}${sep}`)
                ? `inherited skills live in the parent repo; fix them there, then re-run 'agentdef sync'`
                : undefined,
        });
    }
    // Chain-wide (sync gates on this): every broken knowledge doc surfaces at
    // build time, all at once — the session-start hook only degrades with a
    // marker, so this is where fail-loud lives.
    const knowledge = collectKnowledgeMetadata(agentDir);
    for (const error of knowledge.errors) {
        issues.push({
            level: 'error',
            message: `knowledge: ${error}`,
            // Every one of these is the same two-line edit, and without the remedy the
            // reader has to know the OKF spec to act. Docs under .agentdef/parent are
            // inherited, so they are fixed in the parent repo, not repaired here.
            hint: error.startsWith(`${AGENTDEF_DIR}${sep}`)
                ? `inherited knowledge docs live in the parent repo; fix them there, then re-run 'agentdef sync'`
                : [
                    'add OKF frontmatter at the top of each file listed above:',
                    '  ---',
                    '  type: brand          # free-form; only this field is required',
                    '  title: Competitors   # optional, defaults to the filename',
                    '  ---',
                    "run 'agentdef knowledge lint --fix' to write these automatically",
                ].join('\n       '),
        });
    }
    if (knowledge.entries.length > 0) {
        const size = renderKnowledgeIndex(knowledge.entries, { agentDir }).length;
        // The hook digests its way past INLINE_INDEX_BUDGET, but the static
        // consumers cannot: cursor rules and `knowledge: { hook: false }` embed the
        // index in an instruction file that loads in full, every turn. A running
        // cost, not a cliff, hence a warning.
        if (size > 20_000) {
            issues.push({
                level: 'warning',
                message: `knowledge index is ${size} chars — the session-start hook digests it, but static consumers (cursor rules, 'knowledge: { hook: false }') embed it in full; consider shorter descriptions`,
            });
        }
    }
    return issues;
}
