// The on-disk cache directory agentdef materializes the extends chain into
// (.agentdef/parent, .agentdef/parent/.agentdef/parent, ...). Single-sourced so
// the name, its every use, and the .gitignore entry `init` writes can never
// drift. Formerly `.gitagent`, a name inherited verbatim from open-gitagent;
// renamed to match the tool. It is a regenerable build cache, never committed.
export const AGENTDEF_DIR = '.agentdef';

// Where a git hook records a sync it had to skip because it found no agentdef
// to run (see init.ts). Inside AGENTDEF_DIR so the .gitignore entry init writes
// already covers it. Repo-relative with a forward slash on purpose: the same
// string goes into the bash hooks and is joined onto the agent dir by sync.
export const SYNC_SKIPPED = `${AGENTDEF_DIR}/sync-skipped`;

// The previous cache dir name. Kept only so `agentdef init` can migrate a repo
// off it (untrack + delete the stale .gitagent/). Remove once no repo has one.
export const LEGACY_AGENTDEF_DIR = '.gitagent';
