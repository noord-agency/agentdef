import { writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AGENTDEF_DIR, LEGACY_AGENTDEF_DIR } from './paths.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
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
      { cwd, stdio: 'pipe' },
    );
  } catch {
    // not tracked (or git unavailable here); the disk removal below is enough.
  }
  rmSync(legacy, { recursive: true, force: true });
  return true;
}

// Hooks run `agentdef sync`, but only when agent sources actually changed, so a
// routine pull doesn't regenerate for nothing. They live in the repo's local
// .git/hooks (never committed), so no repo needs an orchestration script.
const SOURCE_GUARD = `for f in $changed; do
  case "$f" in
    SOUL.md|RULES.md|agent.yaml|skills/*|agents/*) exec agentdef sync ;;
  esac
done`;

const MISSING_GUARD =
  'command -v agentdef >/dev/null 2>&1 || { echo "agentdef not installed; skipping sync" >&2; exit 0; }';

const HOOKS: Record<string, string> = {
  'post-merge': `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate agent config after merge/pull.
${MISSING_GUARD}
changed=$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD 2>/dev/null || true)
${SOURCE_GUARD}
`,
  'post-checkout': `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate on branch checkout when sources differ.
[ "$3" = "1" ] || exit 0
[ "$1" = "$2" ] && exit 0
${MISSING_GUARD}
changed=$(git diff-tree -r --name-only --no-commit-id "$1" "$2" 2>/dev/null || true)
${SOURCE_GUARD}
`,
  'post-rewrite': `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate after a rebase.
[ "$1" = "rebase" ] || exit 0
${MISSING_GUARD}
exec agentdef sync
`,
};

export interface InitResult {
  hooksDir: string;
  installed: string[];
  unsetHooksPath: boolean;
  gitignoreAdded: boolean;
  legacyRemoved: boolean;
}

// Install agentdef's git hooks into the repo's local .git/hooks. If a custom
// core.hooksPath is set (e.g. a committed .githooks), unset it so the local
// hooks run, that committed dir can then be deleted.
export function init(dir: string): InitResult {
  const cwd = resolve(dir);
  const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd);
  const hooksDir = join(gitDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  let unsetHooksPath = false;
  let current = '';
  try {
    current = git(['config', '--local', '--get', 'core.hooksPath'], cwd);
  } catch {
    current = '';
  }
  if (current) {
    execFileSync('git', ['config', '--local', '--unset', 'core.hooksPath'], { cwd });
    unsetHooksPath = true;
  }

  const installed: string[] = [];
  for (const [name, body] of Object.entries(HOOKS)) {
    const path = join(hooksDir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    installed.push(name);
  }

  const gitignoreAdded = ensureGitignore(cwd);
  const legacyRemoved = removeLegacyCache(cwd);
  return { hooksDir, installed, unsetHooksPath, gitignoreAdded, legacyRemoved };
}
