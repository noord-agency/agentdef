import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
// Hooks run `agentdef sync`, but only when agent sources actually changed, so a
// routine pull doesn't regenerate for nothing. They live in the repo's local
// .git/hooks (never committed), so no repo needs an orchestration script.
const SOURCE_GUARD = `for f in $changed; do
  case "$f" in
    SOUL.md|RULES.md|agent.yaml|skills/*|agents/*) exec agentdef sync ;;
  esac
done`;
const MISSING_GUARD = 'command -v agentdef >/dev/null 2>&1 || { echo "agentdef not installed; skipping sync" >&2; exit 0; }';
const HOOKS = {
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
// Install agentdef's git hooks into the repo's local .git/hooks. If a custom
// core.hooksPath is set (e.g. a committed .githooks), unset it so the local
// hooks run, that committed dir can then be deleted.
export function init(dir) {
    const cwd = resolve(dir);
    const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd);
    const hooksDir = join(gitDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    let unsetHooksPath = false;
    let current = '';
    try {
        current = git(['config', '--local', '--get', 'core.hooksPath'], cwd);
    }
    catch {
        current = '';
    }
    if (current) {
        execFileSync('git', ['config', '--local', '--unset', 'core.hooksPath'], { cwd });
        unsetHooksPath = true;
    }
    const installed = [];
    for (const [name, body] of Object.entries(HOOKS)) {
        const path = join(hooksDir, name);
        writeFileSync(path, body);
        chmodSync(path, 0o755);
        installed.push(name);
    }
    return { hooksDir, installed, unsetHooksPath };
}
