import { writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AGENTDEF_DIR, LEGACY_AGENTDEF_DIR } from './paths.js';
import { knowledgeDirName } from './knowledge.js';
import { gitSubprocessEnv } from './git-env.js';
function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', env: gitSubprocessEnv() }).trim();
}
// Ensure the repo ignores the regenerable cache dir, so .agentdef/ (the
// materialized extends chain) is never committed. Idempotent: appends the entry
// only when no matching line already exists. Returns whether it added one.
function ensureGitignore(cwd) {
    let toplevel;
    try {
        toplevel = git(['rev-parse', '--show-toplevel'], cwd);
    }
    catch {
        return false; // no working tree (e.g. a bare repo); nothing to ignore
    }
    const entry = `${AGENTDEF_DIR}/`;
    const path = join(toplevel, '.gitignore');
    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    const present = existing
        .split('\n')
        .map((l) => l.trim())
        .some((l) => l === entry || l === AGENTDEF_DIR);
    if (present)
        return false;
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(path, `${existing}${prefix}${entry}\n`);
    return true;
}
// One-time migration off the old cache name: if a repo still carries a (possibly
// committed) .gitagent/, untrack it from git and delete it from disk. Safe — it
// is a regenerable cache, rebuilt under .agentdef/ on the next sync. Returns
// whether anything was removed.
function removeLegacyCache(cwd) {
    const legacy = join(cwd, LEGACY_AGENTDEF_DIR);
    if (!existsSync(legacy))
        return false;
    try {
        // --ignore-unmatch: fine if it was never committed; disk removal still runs.
        execFileSync('git', ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', LEGACY_AGENTDEF_DIR], { cwd, stdio: 'pipe', env: gitSubprocessEnv() });
    }
    catch {
        // not tracked (or git unavailable here); the disk removal below is enough.
    }
    rmSync(legacy, { recursive: true, force: true });
    return true;
}
// Hooks run `agentdef sync`, but only when agent sources actually changed, so a
// routine pull doesn't regenerate for nothing. They live in the repo's local
// .git/hooks (never committed), so no repo needs an orchestration script. The
// knowledge dir is rendered from agent.yaml at init time (a repo that renames it
// re-runs `agentdef init` to refresh the hooks — they are idempotent).
function sourceGuard(knowledgeDir) {
    return `for f in $changed; do
  case "$f" in
    SOUL.md|RULES.md|DUTIES.md|agent.yaml|skills/*|agents/*|memory/*|${knowledgeDir}/*) exec agentdef sync ;;
  esac
done`;
}
const MISSING_GUARD = 'command -v agentdef >/dev/null 2>&1 || { echo "agentdef not installed; skipping sync" >&2; exit 0; }';
function buildHooks(knowledgeDir) {
    const guard = sourceGuard(knowledgeDir);
    return {
        'post-merge': `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate agent config after merge/pull.
${MISSING_GUARD}
changed=$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD 2>/dev/null || true)
${guard}
`,
        'post-checkout': `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate on branch checkout when sources differ.
[ "$3" = "1" ] || exit 0
[ "$1" = "$2" ] && exit 0
${MISSING_GUARD}
changed=$(git diff-tree -r --name-only --no-commit-id "$1" "$2" 2>/dev/null || true)
${guard}
`,
        // The siblings all cover "the change arrived from elsewhere" (pull, checkout,
        // rebase). None covers the local case: hand-editing a skill leaves the
        // generated output stale until the next pull. That gap is not Claude-shaped.
        // KNOWLEDGE_HOOK in hooks.ts only has a SessionStart slot for claude and
        // gemini; every other tool in SKILL_DIR (cursor, codex, opencode, kiro,
        // copilot, antigravity) has no hook slot at all. git is the one layer they
        // all share, so the trigger belongs here rather than once per tool.
        //
        // A rebase fires this hook once per replayed commit, so it bails out while
        // one is in progress. Syncing mid-replay leaves generated files dirty, git
        // then refuses to overwrite them for the next commit in the todo list, and
        // the rebase stops half-finished. post-rewrite already syncs a rebase once,
        // after it lands.
        //
        // --root so a repo's very first commit is diffed against the empty tree
        // instead of silently producing no paths. -m so a merge commit is diffed
        // against its parents at all: a conflicted merge never reaches post-merge,
        // and the hand-made commit that finishes it would otherwise report no paths.
        // -m repeats the diff per parent, so a path can appear several times and the
        // paths of both sides show up, not just the conflicted ones. Both are
        // harmless here, the guard execs on the first hit.
        'post-commit': `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate after a commit touches agent sources.
[ -d "$(git rev-parse --git-path rebase-merge)" ] && exit 0
[ -d "$(git rev-parse --git-path rebase-apply)" ] && exit 0
${MISSING_GUARD}
changed=$(git diff-tree -r --name-only --no-commit-id -m --root HEAD 2>/dev/null || true)
${guard}
`,
        'post-rewrite': `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate after a rebase touches agent sources.
[ "$1" = "rebase" ] || exit 0
${MISSING_GUARD}
changed=$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD 2>/dev/null || true)
${guard}
`,
    };
}
// Install agentdef's git hooks into the repo's local .git/hooks. If a custom
// core.hooksPath is set (e.g. a committed .githooks), unset it so the local
// hooks run, that committed dir can then be deleted.
export function init(dir) {
    const cwd = resolve(dir);
    const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd);
    const hooksDir = join(gitDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    // The name is interpolated into a sh case pattern, so restrict it to plain
    // relative path characters — anything else would corrupt the hooks silently.
    const knowledgeDir = knowledgeDirName(cwd);
    if (!/^[A-Za-z0-9._/-]+$/.test(knowledgeDir) || knowledgeDir.startsWith('/')) {
        throw new Error(`agent.yaml: knowledge.dir "${knowledgeDir}" must be a plain relative path (letters, digits, . _ - /)`);
    }
    let unsetHooksPath = false;
    let current = '';
    try {
        current = git(['config', '--local', '--get', 'core.hooksPath'], cwd);
    }
    catch {
        current = '';
    }
    if (current) {
        execFileSync('git', ['config', '--local', '--unset', 'core.hooksPath'], { cwd, env: gitSubprocessEnv() });
        unsetHooksPath = true;
    }
    // Whatever is left comes from the global or system scope, and it wins over
    // .git/hooks just the same. Unsetting a machine-wide setting from a per-repo
    // command would be overreach, so this is reported, not repaired: without it
    // init writes four hooks, says so, and git runs a different directory's hooks
    // or none at all, which is the exact silence agentdef exists to avoid.
    let externalHooksPath = '';
    try {
        externalHooksPath = git(['config', '--get', 'core.hooksPath'], cwd);
    }
    catch {
        externalHooksPath = '';
    }
    const installed = [];
    for (const [name, body] of Object.entries(buildHooks(knowledgeDir))) {
        const path = join(hooksDir, name);
        writeFileSync(path, body);
        chmodSync(path, 0o755);
        installed.push(name);
    }
    const gitignoreAdded = ensureGitignore(cwd);
    const legacyRemoved = removeLegacyCache(cwd);
    return { hooksDir, installed, unsetHooksPath, externalHooksPath, gitignoreAdded, legacyRemoved };
}
