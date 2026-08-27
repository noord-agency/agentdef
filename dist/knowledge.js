import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, basename, sep } from 'node:path';
import yaml from 'js-yaml';
import { collectSourceRoots } from './sources.js';
import { loadAgentManifest } from './loader.js';
// Knowledge documents follow Google's Open Knowledge Format (OKF, Apache-2.0):
// markdown files with YAML frontmatter where only `type` is required (and
// explicitly free-form — no central vocabulary, agentdef never interprets it).
// Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
// Per the spec, consumers must tolerate unknown types, unknown extra keys, and
// missing optional fields; only a missing/empty `type` (or no frontmatter at
// all) is a conformance error, which per noord's fail-loud rule must throw.
export const DEFAULT_KNOWLEDGE_DIR = 'knowledge';
// OKF reserved filenames: directory listings and update logs, valid at any
// directory level. Never concept documents, so discovery skips them.
const RESERVED_FILES = new Set(['index.md', 'log.md']);
// The one shape a knowledge doc must have. Shared so discovery and validation
// agree on what counts as frontmatter — a README skipped here but parsed there
// would reintroduce exactly the false positive this is meant to remove.
// \r? for the same reason as in skills.ts: a Windows checkout of an LF blob
// delivers ---\r\n, and rejecting that as "no frontmatter" broke every doc in
// the repo at once.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
// README.md is a folder explainer by repo convention, not an OKF concept doc, so
// a plain one is skipped rather than reported as broken. Unlike index.md/log.md
// the skip is conditional: a README that deliberately carries OKF frontmatter
// stays indexed (noord-template-repo has one), so nothing that was being indexed
// silently disappears.
function isUnannotatedReadme(filePath) {
    if (basename(filePath) !== 'README.md')
        return false;
    return !FRONTMATTER_RE.test(readFileSync(filePath, 'utf-8'));
}
// The knowledge folder name for one chain level, from that level's agent.yaml
// (`knowledge: { dir: ... }`), defaulting to knowledge/. A resolver rather than
// a constant so every level of the extends chain can use its own name.
export function knowledgeDirName(levelDir) {
    if (!existsSync(join(levelDir, 'agent.yaml')))
        return DEFAULT_KNOWLEDGE_DIR;
    const dir = loadAgentManifest(levelDir)?.knowledge?.dir;
    return typeof dir === 'string' && dir.trim() !== '' ? dir : DEFAULT_KNOWLEDGE_DIR;
}
// Whether the hook-mode adapters (claude-code, gemini) deliver the index via a
// SessionStart hook. `knowledge: { hook: false }` opts out: sync stops
// registering (and never re-registers after `agentdef knowledge unhook`), and
// CLAUDE.md/GEMINI.md carry the full static index instead of a breadcrumb.
// Local manifest only: the consuming repo decides its own delivery mechanism,
// a parent cannot force hooks onto children.
export function knowledgeHookEnabled(agentDir) {
    if (!existsSync(join(agentDir, 'agent.yaml')))
        return true;
    return loadAgentManifest(agentDir)?.knowledge?.hook !== false;
}
// OKF frontmatter only; bodies stay untouched so bundles remain OKF-portable.
// `displayRoot` only affects error text: errors are read by a human fixing the
// file, usually from a CI log, where the absolute runner path (/home/runner/
// work/...) names a location that exists on no developer machine. Defaulting it
// to rootDir keeps the two-argument callers unchanged.
export function loadKnowledgeMetadata(filePath, rootDir, displayRoot = rootDir) {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(FRONTMATTER_RE);
    const shown = relative(displayRoot, filePath);
    if (!match) {
        throw new Error(`${shown} is missing YAML frontmatter (---)`);
    }
    const fm = yaml.load(match[1]);
    const type = fm?.type == null ? '' : String(fm.type).trim();
    if (type === '') {
        throw new Error(`${shown} is missing the required OKF field: type`);
    }
    const timestamp = fm?.timestamp;
    return {
        type,
        title: fm?.title ? String(fm.title) : basename(filePath, '.md'),
        description: fm?.description ? String(fm.description) : undefined,
        tags: Array.isArray(fm?.tags) ? fm.tags.map(String) : undefined,
        timestamp: timestamp instanceof Date
            ? timestamp.toISOString()
            : timestamp != null
                ? String(timestamp)
                : undefined,
        resource: fm?.resource ? String(fm.resource) : undefined,
        relPath: relative(rootDir, filePath),
        path: filePath,
    };
}
// Recursive: OKF bundles are arbitrary directory trees (unlike skills' fixed
// one-level layout). Only .md files count; everything else is bundle assets.
// Symlinks are not followed (isDirectory() is false for them — skills parity).
function listKnowledgeFiles(dir, out) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            listKnowledgeFiles(path, out);
        }
        else if (entry.isFile() && entry.name.endsWith('.md') && !RESERVED_FILES.has(entry.name)) {
            out.push(path);
        }
    }
}
// Merged across local knowledge/ + the extends parent + deps, deduped by
// relPath (the OKF concept ID) with the nearest definition winning, then sorted
// by relPath (code-unit order — deterministic across machines and locales).
// Lenient by design: per-file errors are collected, not thrown, because the two
// consumers need different failure modes — validate() turns them into fail-loud
// build errors (so sync aborts), while the session-start hook must keep every
// parseable entry and degrade with a marker instead of breaking sessions.
export function collectKnowledgeMetadata(agentDir) {
    const seen = new Set();
    const entries = [];
    const errors = [];
    const base = resolve(agentDir);
    for (const root of collectSourceRoots(base, knowledgeDirName)) {
        const files = [];
        listKnowledgeFiles(root, files);
        for (const file of files) {
            if (isUnannotatedReadme(file))
                continue;
            try {
                // Errors are shown relative to the agent dir, not the knowledge root, so
                // they read as the path the human has to open (knowledge/brand/x.md),
                // and an inherited doc is visibly inherited (.agentdef/parent/...).
                const doc = loadKnowledgeMetadata(file, root, base);
                if (seen.has(doc.relPath))
                    continue;
                seen.add(doc.relPath);
                entries.push(doc);
            }
            catch (e) {
                errors.push(e.message);
            }
        }
    }
    entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    return { entries, errors };
}
// For build-time consumers (the adapters): a broken knowledge doc must surface,
// not vanish from the generated index. Under sync, validate() reports the same
// errors first (with all of them at once), so this throw is only ever reached
// by a direct `agentdef export`.
export function collectKnowledgeMetadataStrict(agentDir) {
    const { entries, errors } = collectKnowledgeMetadata(agentDir);
    if (errors.length > 0) {
        throw new Error(errors.join('\n'));
    }
    return entries;
}
// Quote anything that would not survive a YAML round trip as a bare scalar (a
// colon, a leading dash, a hash). A double-quoted JSON string is valid YAML.
function yamlScalar(value) {
    return /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(value) ? value : JSON.stringify(value);
}
// The folder a doc sits in is the one type signal that is already there and
// already curated: knowledge/brand/x.md is brand knowledge. Specifically the
// TOP-level folder under the knowledge root, not the immediate parent — deeper
// levels are per-project or per-batch, so knowledge/seo/internal-linking/
// hansetherm-waermepumpe-2026-05/x.md is seo knowledge, and the immediate parent
// would yield "hansetherm-waermepumpe-2026-05" as a type, which is a folder name
// masquerading as a category. Files directly in the root have no such signal and
// get a neutral placeholder the human is told to review.
function inferType(filePath, root) {
    const segments = relative(root, filePath).split(sep);
    return segments.length > 1 ? segments[0] : 'note';
}
function inferTitle(content, filePath) {
    const h1 = content.match(/^#\s+(.+)$/m);
    return h1 ? h1[1].trim() : basename(filePath, '.md');
}
// Reports (and optionally repairs) knowledge docs that would fail validate().
// Deliberately LOCAL-only: the extends chain is a regenerable cache under
// .agentdef/, so writing there would be undone by the next sync and would edit
// a repo the user does not own. Inherited breakage is the parent repo's to fix.
//
// This does not soften validate(): it stays fail-loud, and repair is a separate
// command a human runs and reviews, the same shape as `ruff --fix`.
export function lintKnowledge(agentDir, opts = {}) {
    const base = resolve(agentDir);
    const root = join(base, knowledgeDirName(base));
    const findings = [];
    const fixed = [];
    if (!existsSync(root))
        return { findings, fixed };
    const files = [];
    listKnowledgeFiles(root, files);
    files.sort();
    for (const file of files) {
        if (isUnannotatedReadme(file))
            continue;
        const content = readFileSync(file, 'utf-8');
        const relPath = relative(base, file);
        if (FRONTMATTER_RE.test(content)) {
            // Frontmatter is present, so the only remaining failure is the `type`
            // rule. Anything loadKnowledgeMetadata rejects here needs a human.
            try {
                loadKnowledgeMetadata(file, root, base);
            }
            catch (e) {
                findings.push({
                    relPath,
                    path: file,
                    reason: 'malformed-frontmatter',
                    detail: e.message,
                });
            }
            continue;
        }
        const proposed = { type: inferType(file, root), title: inferTitle(content, file) };
        findings.push({ relPath, path: file, reason: 'missing-frontmatter', proposed });
        if (opts.fix) {
            const block = `---\ntype: ${yamlScalar(proposed.type)}\ntitle: ${yamlScalar(proposed.title)}\n---\n\n`;
            writeFileSync(file, block + content);
            fixed.push(relPath);
        }
    }
    return { findings, fixed };
}
// The ONE index renderer, shared by the static instruction-file sections and
// the session-start hook so both inject byte-identical content. Compact by
// design (type, title, description, pointer — tags/timestamp/resource are
// parsed but not rendered): tools load the full document on demand via the
// pointer, like the skills index. Pointers are real repo-relative paths —
// knowledge is indexed, never mirrored, so inherited docs point into the
// regenerated .agentdef/ cache (fine: instruction files are themselves
// gitignored build artifacts that only exist alongside that cache).
export function renderKnowledgeIndex(entries, opts) {
    const agentDir = resolve(opts.agentDir);
    const parts = ['## Knowledge', ''];
    for (const doc of entries) {
        parts.push(`### ${doc.title} (${doc.type})`);
        if (doc.description)
            parts.push(doc.description);
        parts.push(`Full document: \`${relative(agentDir, doc.path)}\``);
        parts.push('');
    }
    return parts.join('\n').trimEnd();
}
// Above this, the hook parks the index on disk and injects a digest instead.
// Hosts truncate or offload oversized hook stdout, and a truncated index does
// not degrade, it silently disappears: measured on one host, 11 of 108 entries
// arrived and the sort order decided which. The limits are undocumented and
// differ per host, so 8k is a conservative floor, not a measurement — too low
// costs one Read, too high costs the corpus.
export const INLINE_INDEX_BUDGET = 8_000;
// Stands in for the index when the corpus outgrows INLINE_INDEX_BUDGET. Must
// stay small at any corpus size — a digest that is itself offloaded would fail
// exactly like the index it replaces.
export function renderKnowledgeDigest(entries, opts) {
    const counts = new Map();
    for (const doc of entries)
        counts.set(doc.type, (counts.get(doc.type) ?? 0) + 1);
    // Biggest group first, ties alphabetical: deterministic across machines, and
    // the head of the line is the part worth reading.
    const shape = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([type, n]) => `${type} (${n})`)
        .join(' · ');
    return [
        '## Knowledge',
        '',
        `${entries.length} documents are indexed for this agent: ${shape}.`,
        '',
        `The index — title, type and a one-line description per document, with a path to each —`,
        `is at \`${opts.indexPath}\`. It is rewritten at every session start.`,
        '',
        `Read it before assuming something is not written down, then open the documents it points to.`,
        `It is too large to inject here without being truncated, so this digest stands in for it.`,
    ].join('\n');
}
// For hook-mode instruction files (CLAUDE.md, GEMINI.md): the full index is
// injected fresh at session start, so the file itself only carries a pointer —
// humans reading it still learn the corpus exists, and an agent whose hook
// never ran can still browse the folder.
export function renderKnowledgeBreadcrumb(knowledgeDir, settingsFile) {
    return [
        '## Knowledge',
        '',
        `A knowledge index from \`${knowledgeDir}/\` is injected fresh at each session start`,
        `via a SessionStart hook (registered in \`${settingsFile}\` by \`agentdef sync\`).`,
        `If it is missing from context, run \`agentdef sync\` and start a new session.`,
    ].join('\n');
}
