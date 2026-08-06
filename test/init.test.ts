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
  // A stub `agentdef` on PATH that just records that it ran, so the assertion
  // is "did the hook invoke agentdef", not a side effect of what sync does.
  function withStubAgentdef<T>(fn: (calledMarker: string) => T): T {
    const binDir = mkdtempSync(join(tmpdir(), 'agentdef-stub-bin-'));
    dirs.push(binDir);
    const marker = join(binDir, 'called.log');
    const stub = join(binDir, 'agentdef');
    writeFileSync(stub, `#!/usr/bin/env bash\necho "synced for: $*" >> "${marker}"\n`);
    chmodSync(stub, 0o755);
    const restore = process.env.PATH;
    process.env.PATH = `${binDir}:${restore}`;
    try {
      return fn(marker);
    } finally {
      process.env.PATH = restore;
    }
  }

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
