// Git hooks (post-merge, post-checkout, post-rewrite) run with GIT_DIR and
// GIT_WORK_TREE already set in the environment, pointing at whichever
// repository/worktree triggered the hook. Those ambient vars override a
// `-C <dir>` argument (or a mismatched `cwd`) for every git subprocess spawned
// while they're set, so a hook-invoked `agentdef sync` that means to target a
// *different* directory — e.g. `sparse-checkout set` on .agentdef/parent — can
// have that command silently redirected onto the hook's own repository
// instead. That is exactly how a nested task worktree's project tree got
// sparse-checked-out to agentdef's own essentials after an ordinary rebase.
// Every git subprocess this tool spawns passes through gitSubprocessEnv() so
// `-C`/`cwd` stays authoritative no matter who invoked agentdef.
const AMBIENT_GIT_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
];

export function gitSubprocessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of AMBIENT_GIT_ENV_VARS) delete env[key];
  return env;
}
