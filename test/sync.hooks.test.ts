// The git hooks live in .git/hooks, outside the npm package, so upgrading
// agentdef never reached them: each hook fix needed a second `agentdef init` on
// every machine, and nothing said so when it was forgotten. sync now rewrites
// agentdef's own hooks when they differ from what this version would install,
// and reports what a hook had to skip. These tests pin both, and the boundary:
// hooks agentdef did not write are never touched.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, buildHooks, hookRunner } from '../src/init.js';
import { sync } from '../src/sync.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@e',
};
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: 'pipe' }).trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

// A repo sync can complete in: one adapter, no extends, nothing to validate away.
function fixture(agentYaml = 'name: t\ndescription: t\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'agentdef-sync-hooks-test-'));
  dirs.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  write(root, { 'agent.yaml': agentYaml, 'SOUL.md': '# soul\n', '.agent-adapters': 'claude-code\n' });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

const hook = (root: string, name: string) => join(root, '.git', 'hooks', name);
const REFRESHED = /^git hooks refreshed: /;

// What 0.8.5 installed: PATH only, so it skipped under every GUI git client.
const OLD_POST_MERGE = `#!/usr/bin/env bash
# Installed by 'agentdef init'. Regenerate agent config after merge/pull.
command -v agentdef >/dev/null 2>&1 || { echo "agentdef not installed; skipping sync" >&2; exit 0; }
changed=$(git diff-tree -r --name-only --no-commit-id ORIG_HEAD HEAD 2>/dev/null || true)
for f in $changed; do
  case "$f" in
    SOUL.md|RULES.md|DUTIES.md|agent.yaml|skills/*|agents/*|memory/*|knowledge/*) exec agentdef sync ;;
  esac
done
`;
const FOREIGN = '#!/bin/sh\n# lefthook, or something written by hand\nexec lefthook run "$0" "$@"\n';

describe('sync refreshes the hooks agentdef installed', () => {
  test('a hook from an older agentdef is rewritten, hooks agentdef did not write are not', () => {
    const root = fixture();
    init(root);
    writeFileSync(hook(root, 'post-merge'), OLD_POST_MERGE);
    // Same name as one of ours, but someone else's file now.
    writeFileSync(hook(root, 'post-checkout'), FOREIGN);
    writeFileSync(hook(root, 'pre-commit'), FOREIGN);

    const res = sync(root);

    assert.deepEqual(res.written.filter((w) => REFRESHED.test(w)), ['git hooks refreshed: post-merge']);
    assert.equal(readFileSync(hook(root, 'post-merge'), 'utf-8'), buildHooks('knowledge', hookRunner())['post-merge']);
    assert.equal(statSync(hook(root, 'post-merge')).mode & 0o777, 0o755, 'still executable');
    assert.equal(readFileSync(hook(root, 'post-checkout'), 'utf-8'), FOREIGN);
    assert.equal(readFileSync(hook(root, 'pre-commit'), 'utf-8'), FOREIGN);
  });

  test('hooks that already match are left alone and nothing is reported', () => {
    const root = fixture();
    init(root);
    const before = readFileSync(hook(root, 'post-commit'), 'utf-8');

    const res = sync(root);

    assert.equal(res.written.filter((w) => REFRESHED.test(w)).length, 0);
    assert.equal(readFileSync(hook(root, 'post-commit'), 'utf-8'), before);
  });

  // Same knowledge dir logic as init: renaming it in agent.yaml used to need a
  // second init before the hooks watched the new name.
  test('a renamed knowledge dir reaches the hooks on the next sync', () => {
    const root = fixture();
    init(root);
    write(root, { 'agent.yaml': 'name: t\ndescription: t\nknowledge:\n  dir: docs\n' });

    const res = sync(root);

    assert.equal(res.written.filter((w) => REFRESHED.test(w)).length, 1);
    for (const name of ['post-merge', 'post-checkout', 'post-commit', 'post-rewrite']) {
      assert.match(readFileSync(hook(root, name), 'utf-8'), /\|docs\/\*\) agentdef_sync ;;/, name);
    }
  });

  // The hooks run `agentdef sync` in the top level of the work tree, so they
  // belong to the agent there. A nested agent synced with --dir brings its own
  // knowledge dir: refreshing from it made the root hooks watch that one
  // instead, edits to the root knowledge dir stopped triggering a sync, and the
  // next plain sync flipped the hooks back.
  test('syncing a nested agent leaves the repo hooks to the top-level agent', () => {
    const root = fixture();
    write(root, {
      'sub/agent.yaml': 'name: sub\ndescription: s\nknowledge:\n  dir: notes\n',
      'sub/SOUL.md': '# sub\n',
      'sub/.agent-adapters': 'claude-code\n',
    });
    init(root);

    const nested = sync(join(root, 'sub'));

    assert.equal(nested.written.filter((w) => REFRESHED.test(w)).length, 0);
    for (const name of ['post-merge', 'post-checkout', 'post-commit', 'post-rewrite']) {
      assert.match(readFileSync(hook(root, name), 'utf-8'), /\|knowledge\/\*\) agentdef_sync ;;/, name);
    }
    assert.equal(sync(root).written.filter((w) => REFRESHED.test(w)).length, 0, 'nothing for the next sync to undo');
  });

  // sync runs in CI checkouts and in repos nobody ran init in. Installing hooks
  // there is init's decision, not a side effect of generating files.
  test('a hook that is not there is not installed', () => {
    const root = fixture();
    init(root);
    rmSync(hook(root, 'post-commit'));
    const bare = fixture();

    sync(root);
    sync(bare);

    assert.ok(!existsSync(hook(root, 'post-commit')));
    for (const name of ['post-merge', 'post-checkout', 'post-commit', 'post-rewrite']) {
      assert.ok(!existsSync(hook(bare, name)), name);
    }
  });
});

describe('sync and the record of skipped hook syncs', () => {
  const RECORD = [
    '2026-10-01T08:00:00Z post-commit: agentdef not found (PATH=/usr/bin:/bin:/usr/sbin:/sbin)',
    '2026-10-02T09:30:00Z post-merge: agentdef not found (PATH=/usr/bin:/bin:/usr/sbin:/sbin)',
  ];

  test('is reported with its content and cleared once sync has caught up', () => {
    const root = fixture();
    write(root, { '.agentdef/sync-skipped': `${RECORD.join('\n')}\n` });

    const res = sync(root);

    const warning = res.warnings.find((w) => w.includes('could not find agentdef'));
    assert.ok(warning, 'the skip must surface as a warning');
    assert.match(warning, /skipped 2 sync\(s\)/);
    for (const line of RECORD) assert.ok(warning.includes(line), line);
    assert.ok(!existsSync(join(root, '.agentdef', 'sync-skipped')));
    assert.equal(sync(root).warnings.some((w) => w.includes('could not find agentdef')), false, 'reported once');
  });

  test('survives a sync that fails, since nothing has caught up', () => {
    const root = fixture();
    write(root, {
      '.agentdef/sync-skipped': `${RECORD[0]}\n`,
      'skills/broken/SKILL.md': 'no frontmatter here\n',
    });

    assert.throws(() => sync(root), /validation failed/);

    assert.equal(readFileSync(join(root, '.agentdef', 'sync-skipped'), 'utf-8'), `${RECORD[0]}\n`);
  });
});
