import { writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { AGENTDEF_DIR, LEGACY_AGENTDEF_DIR, SYNC_SKIPPED } from './paths.js';
import { knowledgeDirName } from './knowledge.js';
import { gitSubprocessEnv } from './git-env.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: gitSubprocessEnv() }).trim();
}

// Ensure the repo ignores the regenerable cache dir, so .agentdef/ (the
// materialized extends chain) is never committed. Idempotent: appends the entry
// only when no matching line already exists. Returns whether it added one.
function ensureGitignore(cwd: string): boolean {
  let toplevel: string;
  try {
    toplevel = git(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    return false; // no working tree (e.g. a bare repo); nothing to ignore
  }
  const entry = `${AGENTDEF_DIR}/`;
  const path = join(toplevel, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const present = existing
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === entry || l === AGENTDEF_DIR);
  if (present) return false;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${existing}${prefix}${entry}\n`);
  return true;
}

// One-time migration off the old cache name: if a repo still carries a (possibly
// committed) .gitagent/, untrack it from git and delete it from disk. Safe — it
// is a regenerable cache, rebuilt under .agentdef/ on the next sync. Returns
// whether anything was removed.
function removeLegacyCache(cwd: string): boolean {
  const legacy = join(cwd, LEGACY_AGENTDEF_DIR);
  if (!existsSync(legacy)) return false;
  try {
    // --ignore-unmatch: fine if it was never committed; disk removal still runs.
    execFileSync(
      'git',
      ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', LEGACY_AGENTDEF_DIR],
      { cwd, stdio: 'pipe', env: gitSubprocessEnv() },
    );
  } catch {
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
function sourceGuard(knowledgeDir: string): string {
  return `for f in $changed; do
  case "$f" in
    SOUL.md|RULES.md|DUTIES.md|agent.yaml|skills/*|agents/*|memory/*|${knowledgeDir}/*) agentdef_sync ;;
  esac
done`;
}

// How a hook reaches agentdef. `agentdef` on PATH is not enough: a GUI git
// client runs hooks with the PATH the OS gave the app, on macOS
// /usr/bin:/bin:/usr/sbin:/sbin (Obsidian Git is one such client). agentdef is a
// node script that lives wherever its user's node lives (nvm, Homebrew, a tool's
// private prefix, npm on Windows), so neither node nor agentdef is on that PATH.
// The hook skipped, the stderr line saying so went nowhere a GUI shows, and the
// generated files sat stale for weeks. A per-machine PATH setting would have to
// be redone for each of those layouts, so the hook carries the absolute paths
// of the agentdef that wrote it instead: the node binary and the CLI entry.
export interface HookRunner {
  node: string;
  cli: string;
}

export interface HookRunnerSource {
  platform?: NodeJS.Platform;
  execPath?: string;
  cliPath?: string;
}

// The CLI entry of this install: dist/cli.js, next to this module. Not
// process.argv[1], which is the CLI only when the CLI is what is running. init()
// and sync() are also called in-process (the tests, `npm run dev` under tsx),
// and argv[1] is then a test file the hook would go on to execute. Under tsx
// there is no src/cli.js; the path is baked anyway, and the hook, which checks
// both paths before using them, falls back to PATH.
function ownCliPath(): string {
  const path = fileURLToPath(new URL('./cli.js', import.meta.url));
  return existsSync(path) ? realpathSync(path) : path;
}

// Platform and paths are parameters so the Windows rendering can be tested on
// any OS. Git for Windows runs hooks in Git Bash, which executes
// C:/Program Files/nodejs/node.exe as written but not reliably the backslash
// form. A backslash is only converted on Windows: elsewhere it is a legal
// character in a file name.
export function hookRunner(source: HookRunnerSource = {}): HookRunner {
  const platform = source.platform ?? process.platform;
  const forShell = (path: string) => (platform === 'win32' ? path.replace(/\\/g, '/') : path);
  return {
    node: forShell(source.execPath ?? process.execPath),
    cli: forShell(source.cliPath ?? ownCliPath()),
  };
}

// POSIX single quotes: nothing inside them is special except the quote itself,
// which closes the string, is escaped, and reopens it. Install paths contain
// spaces (Program Files) and can contain quotes (a home directory for O'Brien).
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// The baked paths first, PATH second, and when neither yields agentdef, loud:
// stderr for a terminal, plus a line in SYNC_SKIPPED for everyone else, which
// the next `agentdef sync` reports and clears. Still exit 0, a missing tool must
// never block git. Only reached once the guard found a changed source, so an
// ordinary commit stays silent and the file does not grow on every autosave.
//
// exec, as before, so sync's exit status is the hook's. exec cannot take a shell
// function, which is why the guard calls agentdef_sync and the exec sits inside
// it, never returning.
function runnerBlock(runner: HookRunner): string {
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

export const HOOK_NAMES = ['post-merge', 'post-checkout', 'post-commit', 'post-rewrite'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

export function buildHooks(knowledgeDir: string, runner: HookRunner): Record<HookName, string> {
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

export interface InitResult {
  hooksDir: string;
  installed: string[];
  unsetHooksPath: boolean;
  // A core.hooksPath that survives the unset below, i.e. one set globally or
  // system-wide. Empty when there is none.
  externalHooksPath: string;
  gitignoreAdded: boolean;
  legacyRemoved: boolean;
}

// Install agentdef's git hooks into the repo's local .git/hooks. If a custom
// core.hooksPath is set (e.g. a committed .githooks), unset it so the local
// hooks run, that committed dir can then be deleted. `runner` is the agentdef
// the hooks will call; a parameter only so tests can point it elsewhere.
export function init(dir: string, runner: HookRunner = hookRunner()): InitResult {
  const cwd = resolve(dir);
  const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd);
  const hooksDir = join(gitDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  // The name is interpolated into a sh case pattern, so restrict it to plain
  // relative path characters — anything else would corrupt the hooks silently.
  const knowledgeDir = knowledgeDirName(cwd);
  if (!/^[A-Za-z0-9._/-]+$/.test(knowledgeDir) || knowledgeDir.startsWith('/')) {
    throw new Error(
      `agent.yaml: knowledge.dir "${knowledgeDir}" must be a plain relative path (letters, digits, . _ - /)`,
    );
  }

  let unsetHooksPath = false;
  let current = '';
  try {
    current = git(['config', '--local', '--get', 'core.hooksPath'], cwd);
  } catch {
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
  } catch {
    externalHooksPath = '';
  }

  const installed: string[] = [];
  for (const [name, body] of Object.entries(buildHooks(knowledgeDir, runner))) {
    const path = join(hooksDir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    installed.push(name);
  }

  const gitignoreAdded = ensureGitignore(cwd);
  const legacyRemoved = removeLegacyCache(cwd);
  return { hooksDir, installed, unsetHooksPath, externalHooksPath, gitignoreAdded, legacyRemoved };
}
