import { writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, basename, delimiter, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { AGENTDEF_DIR, LEGACY_AGENTDEF_DIR, SYNC_SKIPPED } from './paths.js';
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
// knowledge dir is rendered from agent.yaml when the hooks are written; a repo
// that renames it gets matching hooks from the next sync (see refreshHooks).
function sourceGuard(knowledgeDir) {
    return `for f in $changed; do
  case "$f" in
    SOUL.md|RULES.md|DUTIES.md|agent.yaml|skills/*|agents/*|memory/*|${knowledgeDir}/*) agentdef_sync ;;
  esac
done`;
}
// The CLI entry of this install: dist/cli.js, next to this module. Not
// process.argv[1], which is the CLI only when the CLI is what is running. init()
// and sync() are also called in-process (the tests, `npm run dev` under tsx),
// and argv[1] is then a test file the hook would go on to execute. Under tsx
// there is no src/cli.js. init bakes it anyway and warns (the hook checks both
// paths and falls back to PATH), and refreshHooks refuses to bake it at all,
// see missingRunnerPaths.
function ownCliPath() {
    const path = fileURLToPath(new URL('./cli.js', import.meta.url));
    return existsSync(path) ? realpathSync(path) : path;
}
// The baked paths that do not exist. A hook skips such a runner and falls back
// to PATH, so these paths are worth a warning from init and are never a
// reason for sync to replace hooks that might call a runner that works.
export function missingRunnerPaths(runner) {
    return [runner.node, runner.cli].filter((path) => !existsSync(path));
}
// process.execPath is the resolved binary. For Homebrew that is the versioned
// Cellar path (/opt/homebrew/Cellar/node/25.6.1/bin/node), which the cleanup
// after the next `brew upgrade node` deletes, while /opt/homebrew/bin/node on
// PATH is a symlink every upgrade repoints. So when a node on PATH resolves to
// the running binary, the hook gets that name: the same binary today, and still
// there after an upgrade. A shim that resolves to something else (volta, mise)
// is not the running node and is passed over. An nvm PATH entry is the
// versioned binary itself, so nothing changes there. Relative PATH entries are
// skipped, a hook runs in another directory.
function stableNodePath(execPath, pathEnv) {
    let running;
    try {
        running = realpathSync(execPath);
    }
    catch {
        return execPath; // not on disk (an injected path), nothing to compare with
    }
    for (const dir of pathEnv.split(delimiter)) {
        if (!isAbsolute(dir))
            continue;
        const candidate = join(dir, basename(execPath));
        try {
            if (realpathSync(candidate) === running)
                return candidate;
        }
        catch {
            // no such file in this PATH entry
        }
    }
    return execPath;
}
// Platform and paths are parameters so the Windows rendering can be tested on
// any OS. Git for Windows runs hooks in Git Bash, which executes
// C:/Program Files/nodejs/node.exe as written but not reliably the backslash
// form. A backslash is only converted on Windows: elsewhere it is a legal
// character in a file name.
export function hookRunner(source = {}) {
    const platform = source.platform ?? process.platform;
    const forShell = (path) => (platform === 'win32' ? path.replace(/\\/g, '/') : path);
    return {
        node: forShell(stableNodePath(source.execPath ?? process.execPath, source.pathEnv ?? process.env.PATH ?? '')),
        cli: forShell(source.cliPath ?? ownCliPath()),
    };
}
// POSIX single quotes: nothing inside them is special except the quote itself,
// which closes the string, is escaped, and reopens it. Install paths contain
// spaces (Program Files) and can contain quotes (a home directory for O'Brien).
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
// The baked paths first, PATH second, and when neither yields agentdef, loud:
// stderr for a terminal, plus a line in SYNC_SKIPPED for everyone else, which
// the next `agentdef sync` reports and clears. Still exit 0, a missing tool must
// never block git. Only reached once the guard found a changed source, so an
// ordinary commit stays silent and the file does not grow on every autosave.
//
// exec, so this shell is gone before sync starts: sync may rewrite this very
// file (refreshHooks), and bash reads a script incrementally. exec cannot take a
// shell function, which is why the guard calls agentdef_sync and the exec sits
// inside it, never returning.
function runnerBlock(runner) {
    return `AGENTDEF_NODE=${shellQuote(runner.node)}
AGENTDEF_CLI=${shellQuote(runner.cli)}
agentdef_sync() {
  if [ -x "$AGENTDEF_NODE" ] && [ -f "$AGENTDEF_CLI" ]; then
    exec "$AGENTDEF_NODE" "$AGENTDEF_CLI" sync
  fi
  if command -v agentdef >/dev/null 2>&1; then
    exec agentdef sync
  fi
  echo "agentdef: agent sources changed, but agentdef was not found ($AGENTDEF_NODE or $AGENTDEF_CLI is missing, and PATH has none), so nothing was synced. Run 'agentdef sync' in a terminal." >&2
  { mkdir -p ${AGENTDEF_DIR} && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) \${0##*/}: agentdef not found (PATH=$PATH)" >> ${SYNC_SKIPPED}; } 2>/dev/null
  exit 0
}`;
}
// What identifies a hook as agentdef's. refreshHooks rewrites only files that
// carry it; every hook below has it on its second line.
const HOOK_MARKER = /^# Installed by 'agentdef init'\./m;
export const HOOK_NAMES = ['post-merge', 'post-checkout', 'post-commit', 'post-rewrite'];
export function buildHooks(knowledgeDir, runner) {
    const guard = sourceGuard(knowledgeDir);
    const run = runnerBlock(runner);
    return {
        'post-merge': `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate agent config after merge/pull.
${run}
changed=$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD 2>/dev/null || true)
${guard}
`,
        'post-checkout': `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate on branch checkout when sources differ.
[ "$3" = "1" ] || exit 0
[ "$1" = "$2" ] && exit 0
${run}
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
        // harmless here, the guard acts on the first hit and never returns.
        'post-commit': `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate after a commit touches agent sources.
[ -d "$(git rev-parse --git-path rebase-merge)" ] && exit 0
[ -d "$(git rev-parse --git-path rebase-apply)" ] && exit 0
${run}
changed=$(git diff-tree -r --name-only --no-commit-id -m --root HEAD 2>/dev/null || true)
${guard}
`,
        'post-rewrite': `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate after a rebase touches agent sources.
[ "$1" = "rebase" ] || exit 0
${run}
changed=$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD 2>/dev/null || true)
${guard}
`,
    };
}
// The knowledge dir as the hooks render it. The name is interpolated into a sh
// case pattern, so restrict it to plain relative path characters — anything
// else would corrupt the hooks silently.
function hookKnowledgeDir(cwd) {
    const knowledgeDir = knowledgeDirName(cwd);
    if (!/^[A-Za-z0-9._/-]+$/.test(knowledgeDir) || knowledgeDir.startsWith('/')) {
        throw new Error(`agent.yaml: knowledge.dir "${knowledgeDir}" must be a plain relative path (letters, digits, . _ - /)`);
    }
    return knowledgeDir;
}
function writeHook(path, body) {
    writeFileSync(path, body);
    chmodSync(path, 0o755);
}
// Install agentdef's git hooks into the repo's local .git/hooks. If a custom
// core.hooksPath is set (e.g. a committed .githooks), unset it so the local
// hooks run, that committed dir can then be deleted. `runner` is the agentdef
// the hooks will call; a parameter only so tests can point it elsewhere.
export function init(dir, runner = hookRunner()) {
    const cwd = resolve(dir);
    const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd);
    const hooksDir = join(gitDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const knowledgeDir = hookKnowledgeDir(cwd);
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
    for (const [name, body] of Object.entries(buildHooks(knowledgeDir, runner))) {
        writeHook(join(hooksDir, name), body);
        installed.push(name);
    }
    // Still installed: init is asked for hooks, and with the PATH fallback they
    // work from a terminal. The caller says what they will not do.
    const runnerMissing = missingRunnerPaths(runner);
    const gitignoreAdded = ensureGitignore(cwd);
    const legacyRemoved = removeLegacyCache(cwd);
    return { hooksDir, installed, unsetHooksPath, externalHooksPath, runnerMissing, gitignoreAdded, legacyRemoved };
}
// The hooks live in .git/hooks, outside the repo and outside the npm package,
// so upgrading agentdef never reached them: every hook change so far needed a
// second `agentdef init` on every machine, which is easy to forget and invisible
// when forgotten. The baked paths add a third way to go stale, a node upgrade
// that removes the old binary. sync runs constantly (mostly from these very
// hooks), so it brings them up to date, with the same directory and knowledge
// dir init uses.
//
// Only files carrying init's marker are agentdef's. Anything else in
// .git/hooks (husky, lefthook, a hand-written hook) is left untouched, and a
// hook that is missing stays missing: sync does not install what nobody ran
// init for, which also keeps it out of CI checkouts. core.hooksPath is init's
// business (it unsets the local one and reports any other), so sync does not
// touch it and only looks where init writes.
//
// Only the top-level agent refreshes them. A hook runs `agentdef sync` in the
// top level of the work tree and diffs paths relative to it, so that agent's
// knowledge dir is the one the hooks watch. A nested agent synced with
// `--dir sub` shares the repo's hooks without being what they sync; refreshing
// from it pointed them at its knowledge dir, and the next top-level sync
// flipped them back.
//
// A runner that cannot run never replaces one that might. Under `npm run dev`
// (tsx) the CLI entry is src/cli.js, which does not exist; rewriting working
// hooks to it sent every GUI commit back to the PATH fallback and the skip
// record until an installed agentdef synced again. Such hooks are left as they
// are, and notRefreshed says why.
export function refreshHooks(dir, runner = hookRunner()) {
    const none = { refreshed: [], notRefreshed: '' };
    const cwd = resolve(dir);
    // stdio piped: outside a repo git prints "fatal: not a git repository",
    // which is not news for a sync running in a plain directory.
    const quietGit = (args) => execFileSync('git', args, { cwd, encoding: 'utf-8', env: gitSubprocessEnv(), stdio: 'pipe' }).trim();
    let gitDir;
    let prefix;
    try {
        gitDir = quietGit(['rev-parse', '--absolute-git-dir']);
        prefix = quietGit(['rev-parse', '--show-prefix']);
    }
    catch {
        return none; // not a git checkout (a CI tarball, a plain directory), so no hooks
    }
    if (prefix !== '')
        return none; // a nested agent, not the one the hooks sync
    const hooksDir = join(gitDir, 'hooks');
    const ours = new Map();
    for (const name of HOOK_NAMES) {
        const path = join(hooksDir, name);
        if (!existsSync(path))
            continue;
        const text = readFileSync(path, 'utf-8');
        if (HOOK_MARKER.test(text))
            ours.set(name, text);
    }
    // Checked only when there is something to refresh, so a repo without hooks
    // (every CI run) never fails a sync over the knowledge dir name.
    if (ours.size === 0)
        return none;
    const wanted = buildHooks(hookKnowledgeDir(cwd), runner);
    const stale = [...ours].filter(([name, text]) => text !== wanted[name]).map(([name]) => name);
    if (stale.length === 0)
        return none;
    const missing = missingRunnerPaths(runner);
    if (missing.length > 0) {
        return {
            refreshed: [],
            notRefreshed: `git hooks not refreshed (${stale.join(', ')}): ${missing.join(' and ')} ${missing.length === 1 ? 'does' : 'do'} not exist, so this agentdef is not one a hook can run (running from source?). The next sync from an installed agentdef refreshes them.`,
        };
    }
    for (const name of stale)
        writeHook(join(hooksDir, name), wanted[name]);
    return { refreshed: stale, notRefreshed: '' };
}
