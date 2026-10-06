// A hook that has a sync to run and finds no agentdef must not block git, so it
// exits 0. Its stderr line is invisible in a GUI git client, which is exactly
// where that happens, so it also leaves a record that the next `agentdef sync`
// reports. These tests pin the sync half: reported once, with its content, and
// kept until a sync has actually caught up.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentdef-sync-hooks-test-'));
  dirs.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  write(root, { 'agent.yaml': 'name: t\ndescription: t\n', 'SOUL.md': '# soul\n', '.agent-adapters': 'claude-code\n' });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

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
