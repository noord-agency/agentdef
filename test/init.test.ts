// Regression coverage for "agentdef's post-rewrite hook corrupts task
// worktrees on rebase": post-rewrite ran `agentdef sync` unconditionally after
// every rebase, unlike post-merge/post-checkout, which only sync when the
// rewritten range actually touches an agent source path. This asserts
// post-rewrite now carries the identical guard, then proves it behaviourally
// with a real rebase: a plain source-only rebase must not invoke `agentdef`,
// while a rebase that changes skills/* must.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '../src/init.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Merged at call time (not spread once at module load) so a test that mutates
// process.env.PATH (see withStubAgentdef) is honoured by every git call made
// afterwards — including the ones git hooks make on their own.
const GIT_ENV_OVERRIDES = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@e',
};
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...GIT_ENV_OVERRIDES },
    stdio: 'pipe',
  }).trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentdef-init-test-'));
  dirs.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  write(root, {
    'agent.yaml': 'name: t\ndescription: t\n',
    'SOUL.md': '# soul\n',
    'services/app/main.py': 'print(1)\n',
  });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

// fixture() without the initial commit: the only way to reach the `--root` case
// is a repo whose very first commit happens after `agentdef init` has run.
function uncommittedFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentdef-init-test-'));
  dirs.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  write(root, { 'agent.yaml': 'name: t\ndescription: t\n' });
  return root;
}

// A stub `agentdef` on PATH that just records that it ran, so the assertion
// is "did the hook invoke agentdef", not a side effect of what sync does.
// `alsoRuns` is a shell snippet the stub runs after recording, so a test can
// give it the one thing a real sync does that matters here: derive a tracked
// file from an agent source. Tests that only ask "did it run" leave it out.
function withStubAgentdef<T>(fn: (calledMarker: string) => T, alsoRuns = ''): T {
  const binDir = mkdtempSync(join(tmpdir(), 'agentdef-stub-bin-'));
  dirs.push(binDir);
  const marker = join(binDir, 'called.log');
  const stub = join(binDir, 'agentdef');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\necho "synced for: $*" >> "${marker}"\n${alsoRuns}\n`,
  );
  chmodSync(stub, 0o755);
  const restore = process.env.PATH;
  process.env.PATH = `${binDir}:${restore}`;
  try {
    return fn(marker);
  } finally {
    process.env.PATH = restore;
  }
}

describe('post-rewrite hook content', () => {
  test('is guarded like post-merge, not an unconditional sync', () => {
    const root = fixture();
    init(root);
    const hook = readFileSync(join(root, '.git', 'hooks', 'post-rewrite'), 'utf-8');
    const postMerge = readFileSync(join(root, '.git', 'hooks', 'post-merge'), 'utf-8');

    assert.match(hook, /\[ "\$1" = "rebase" \] \|\| exit 0/, 'still only fires on rebase, not amend');
    assert.match(hook, /git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD/, 'computes the rewritten range');
    assert.match(hook, /case "\$f" in/, 'gates on the same path guard as the other hooks');
    assert.doesNotMatch(
      hook,
      /guard\}[\s\S]*exec agentdef sync\n$/,
      'must not fall through to an unconditional sync after the guard',
    );
    // Same guard body as post-merge (only the hook-specific preamble differs).
    const guardBody = (text: string) => text.slice(text.indexOf('changed='));
    assert.equal(guardBody(hook), guardBody(postMerge));
  });
});

describe('post-rewrite hook behaviour (real rebase)', () => {
  test('an ordinary source-only rebase does not invoke agentdef', () => {
    withStubAgentdef((marker) => {
      const root = fixture();
      init(root);
      git(root, ['checkout', '-q', '-b', 'task']);
      write(root, { 'services/app/main.py': 'print(2)\n' });
      git(root, ['commit', '-q', '-am', 'task change']);
      git(root, ['checkout', '-q', 'main']);
      write(root, { 'services/app/other.py': 'print(3)\n' });
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'unrelated main change']);
      git(root, ['checkout', '-q', 'task']);

      // Isolate the assertion to the rebase call itself: `git rebase` performs
      // its own internal branch checkouts (which legitimately fire the already
      // -guarded post-checkout hook too), so any log entries from settling onto
      // `task` above are not what this test is about.
      rmSync(marker, { force: true });
      git(root, ['rebase', 'main']);

      assert.throws(() => readFileSync(marker), 'agentdef must not have been invoked');
    });
  });

  // The skill change lives on `main`, not on `task`: if it were on `task`
  // instead, ORIG_HEAD..HEAD would net to no diff for that file (present,
  // unchanged, on both sides of the rebase) and only the pre-existing
  // post-checkout guard — not this fix — would explain a sync firing. Putting
  // it on the base isolates what post-rewrite's own new guard detects: an
  // upstream skill/agent change pulled in by rebasing onto a moved main,
  // mirroring exactly what post-merge already guards for a pull/merge.
  test('a rebase that pulls in a skills/* change from the new base invokes agentdef', () => {
    withStubAgentdef((marker) => {
      const root = fixture();
      init(root);
      git(root, ['checkout', '-q', '-b', 'task']);
      write(root, { 'services/app/other.py': 'print(3)\n' });
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'unrelated task change']);
      git(root, ['checkout', '-q', 'main']);
      write(root, { 'skills/new/SKILL.md': '---\nname: new\ndescription: d\n---\nbody\n' });
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'main adds a skill']);
      git(root, ['checkout', '-q', 'task']);

      rmSync(marker, { force: true });
      git(root, ['rebase', 'main']);

      const log = readFileSync(marker, 'utf-8');
      assert.match(log, /^synced for: sync$/m);
    });
  });
});

// Same gap, one layer down: post-merge/checkout/rebase all cover changes that
// arrived from elsewhere, so a locally edited skill stayed unsynced until the
// next pull. Only claude and gemini have a SessionStart hook that could paper
// over that; the other adapters have none, which is why the trigger is a git
// hook and not per-tool wiring.
describe('post-commit hook content', () => {
  test('carries the same path guard as post-merge', () => {
    const root = fixture();
    init(root);
    const hook = readFileSync(join(root, '.git', 'hooks', 'post-commit'), 'utf-8');
    const postMerge = readFileSync(join(root, '.git', 'hooks', 'post-merge'), 'utf-8');

    assert.match(
      hook,
      /git diff-tree -r --name-only --no-commit-id -m --root HEAD/,
      'diffs the commit just made: --root so a first commit is not silently empty, -m so a merge commit is not either',
    );
    // Identical guard body as post-merge; only the range computation differs.
    const guardBody = (text: string) => text.slice(text.indexOf('for f in $changed'));
    assert.equal(guardBody(hook), guardBody(postMerge));
  });

  // Both rebase backends: rebase-merge is the modern default, rebase-apply the
  // one `git rebase --apply` (and older git) uses.
  test('stands down while a rebase is replaying commits', () => {
    const root = fixture();
    init(root);
    const hook = readFileSync(join(root, '.git', 'hooks', 'post-commit'), 'utf-8');

    for (const state of ['rebase-merge', 'rebase-apply']) {
      assert.ok(
        hook.includes(`[ -d "$(git rev-parse --git-path ${state})" ] && exit 0`),
        `post-commit must not sync while ${state} is in progress`,
      );
    }
  });
});

describe('post-commit hook behaviour (real commit)', () => {
  test('an ordinary source-only commit does not invoke agentdef', () => {
    withStubAgentdef((marker) => {
      const root = fixture();
      init(root);
      rmSync(marker, { force: true });
      write(root, { 'services/app/main.py': 'print(9)\n' });
      git(root, ['commit', '-q', '-am', 'app change']);

      assert.throws(() => readFileSync(marker), 'agentdef must not have been invoked');
    });
  });

  test('a commit that touches skills/* invokes agentdef', () => {
    withStubAgentdef((marker) => {
      const root = fixture();
      init(root);
      rmSync(marker, { force: true });
      write(root, { 'skills/new/SKILL.md': '---\nname: new\ndescription: d\n---\nbody\n' });
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'add a skill']);

      const log = readFileSync(marker, 'utf-8');
      assert.match(log, /^synced for: sync$/m);
    });
  });

  // The case --root exists for. Every other behaviour test commits before
  // init() runs, so without this one the flag is only ever asserted as hook
  // text: git diff-tree reports no paths at all for a root commit unless it is
  // told to diff against the empty tree.
  test("a repo's very first commit is not invisible to the hook", () => {
    withStubAgentdef((marker) => {
      const root = uncommittedFixture();
      init(root);
      rmSync(marker, { force: true });
      write(root, { 'skills/new/SKILL.md': '---\nname: new\ndescription: d\n---\nbody\n' });
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'first commit ever']);

      const log = readFileSync(marker, 'utf-8');
      assert.match(log, /^synced for: sync$/m);
    });
  });

  // A merge that conflicts never reaches post-merge, and the commit that
  // finishes it by hand is a merge commit, which diff-tree reports as empty
  // unless -m is passed. Without both halves this path syncs nowhere: the test
  // asserts the gap (nothing has run yet at conflict time) and that the
  // hand-made commit closes it.
  test('a merge that conflicted and was finished by hand invokes agentdef', () => {
    withStubAgentdef((marker) => {
      const root = fixture();
      init(root);
      git(root, ['checkout', '-q', '-b', 'task']);
      write(root, { 'skills/new/SKILL.md': '---\nname: new\ndescription: task\n---\nb\n' });
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'task adds a skill']);
      git(root, ['checkout', '-q', 'main']);
      write(root, { 'skills/new/SKILL.md': '---\nname: new\ndescription: main\n---\nb\n' });
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'main adds the same skill']);

      rmSync(marker, { force: true });
      assert.throws(() => git(root, ['merge', 'task']), 'the merge must conflict');
      assert.throws(() => readFileSync(marker), 'post-merge never runs for a conflicted merge');

      write(root, { 'skills/new/SKILL.md': '---\nname: new\ndescription: resolved\n---\nb\n' });
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '--no-edit']);

      const log = readFileSync(marker, 'utf-8');
      assert.match(log, /^synced for: sync$/m);
    });
  });
});

// A rebase fires post-commit once per replayed commit. Syncing there rewrites
// generated files while the todo list is still running, and git aborts the
// rebase rather than overwrite them ("Your local changes to the following files
// would be overwritten by merge"), stranding the user mid-rebase. post-rewrite
// is what syncs a rebase, once, after it lands.
describe('post-commit hook behaviour (during a rebase)', () => {
  // The stub regenerates CLAUDE.md from the skill, so the tree it leaves behind
  // is the real thing under test, not just a log line.
  const generate = '{ cat skills/new/SKILL.md 2>/dev/null || echo none; } > CLAUDE.md';

  test('replaying commits that touch skills/* does not interrupt the rebase', () => {
    withStubAgentdef((marker) => {
      const root = fixture();
      init(root);
      // A consistent baseline: no skill yet, generated output committed to match.
      write(root, { 'CLAUDE.md': 'none\n' });
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'baseline generated output']);

      // The two-commit shape this hook itself produces: commit the source, let
      // post-commit regenerate, commit the regenerated output after it. The
      // first of the two is the one that leaves the output stale in history.
      git(root, ['checkout', '-q', '-b', 'task']);
      write(root, { 'skills/new/SKILL.md': 'skill-v1\n' });
      git(root, ['add', '-A', 'skills']);
      git(root, ['commit', '-q', '-m', 'task adds a skill']);
      assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf-8'), 'skill-v1\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'task commits the regenerated output']);

      git(root, ['checkout', '-q', 'main']);
      write(root, { 'services/app/other.py': 'print(3)\n' });
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'unrelated main change']);
      git(root, ['checkout', '-q', 'task']);

      rmSync(marker, { force: true });
      // Without the bail-out this throws: post-commit syncs after the first
      // replayed commit, CLAUDE.md goes dirty, and git refuses to overwrite it
      // to replay the second one.
      git(root, ['rebase', 'main']);

      assert.equal(git(root, ['status', '--porcelain']), '', 'the rebase left a clean tree');
      assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf-8'), 'skill-v1\n');
      assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '5');
    }, generate);
  });
});

// A hooksPath pointing somewhere else wins over .git/hooks no matter which scope
// set it, and init may only clean up the repo's own. One set globally survives,
// and the failure is the quiet kind: init writes four hooks, reports four hooks,
// and git runs a different directory's, or none at all.
describe('init and a core.hooksPath it is not allowed to clean up', () => {
  function withGlobalGitConfig<T>(contents: string, fn: () => T): T {
    const home = mkdtempSync(join(tmpdir(), 'agentdef-global-gitconfig-'));
    dirs.push(home);
    const path = join(home, 'gitconfig');
    writeFileSync(path, contents);
    const key = 'GIT_CONFIG_GLOBAL';
    const restore = process.env[key];
    process.env[key] = path;
    try {
      return fn();
    } finally {
      if (restore === undefined) delete process.env[key];
      else process.env[key] = restore;
    }
  }

  test('a globally set one is reported, not silently overridden', () => {
    const root = fixture();
    const elsewhere = join(root, 'not-the-hooks-dir');

    const res = withGlobalGitConfig(`[core]\n\thooksPath = ${elsewhere}\n`, () => init(root));

    assert.equal(res.externalHooksPath, elsewhere);
    assert.equal(res.unsetHooksPath, false, 'there was nothing local to unset');
    // The hooks still get written. They just would not run, which is the whole
    // reason for saying so.
    assert.ok(res.installed.includes('post-commit'));
  });

  test('an ordinary repo reports none', () => {
    const root = fixture();

    const res = withGlobalGitConfig('', () => init(root));

    assert.equal(res.externalHooksPath, '');
  });
});
