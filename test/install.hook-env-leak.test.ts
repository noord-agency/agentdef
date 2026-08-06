// End-to-end reproduction of the bug report: "agentdef's post-rewrite hook
// corrupts task worktrees on rebase". `agentdef sync` (which calls install())
// is invoked from inside a git hook, and git hooks run with GIT_DIR and
// GIT_WORK_TREE already set in the environment, pointing at whichever
// repo/worktree fired the hook. Those ambient vars override `-C <targetDir>`
// for every git subprocess while they're set, so the `sparse-checkout set`
// meant for .agentdef/parent landed on the *hook's own* repository instead —
// exactly the "agents/knowledge/skills/tools/guvnor only" cone the bug report
// found in a task worktree after an ordinary `git rebase main`.
//
// This test simulates that ambient environment around a real install() call
// and asserts both halves of the fix: the intended target still gets the
// right selection, and the unrelated "hook repo" is never touched.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from '../src/install.js';

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
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: 'pipe' });
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

const TREE = {
  'SOUL.md': '# soul\n',
  'RULES.md': '# rules\n',
  'skills/foo/SKILL.md': '---\nname: foo\ndescription: a skill\n---\nbody\n',
  'agents/bar.md': 'an agent\n',
  'tools/runtime/cli.js': 'console.log(1);\n',
  'services/real-app/main.py': 'print("this is the actual project")\n',
};

function makeParent(manifest: string): string {
  const base = mkdtempSync(join(tmpdir(), 'agentdef-parent-'));
  dirs.push(base);
  const dir = join(base, 'repo.git');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'uploadpack.allowFilter', 'true']);
  write(dir, { 'agent.yaml': manifest, ...TREE });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return dir;
}

function makeChild(parent: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentdef-child-'));
  dirs.push(dir);
  write(dir, { 'agent.yaml': `name: child\ndescription: c\nextends: file://${parent}\n` });
  return dir;
}

// Stands in for the nested task worktree the hook actually fires in — a real
// project repo with its own tracked source tree, unrelated to the parent
// being synced.
function makeHookRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentdef-hookrepo-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  write(dir, { 'services/real-app/main.py': 'print("victim project")\n' });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'victim fixture']);
  return dir;
}

describe('git hook ambient env does not redirect install()', () => {
  test('GIT_DIR/GIT_WORK_TREE pointing at another repo must not steal the sparse-checkout', () => {
    const child = makeChild(makeParent('name: p\ndescription: p\ninclude:\n  - tools/runtime\n'));
    const hookRepo = makeHookRepo();

    const restore = { ...process.env };
    process.env.GIT_DIR = join(hookRepo, '.git');
    process.env.GIT_WORK_TREE = hookRepo;
    let result;
    try {
      result = install(child, { mode: 'force' });
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, restore);
    }
    assert.deepEqual(result.warnings, []);

    const parentDir = join(child, '.agentdef', 'parent');
    assert.ok(existsSync(join(parentDir, 'agent.yaml')), 'the real target must still receive its selection');
    assert.ok(existsSync(join(parentDir, 'skills/foo/SKILL.md')), 'essentials must land on the real target');
    assert.ok(existsSync(join(parentDir, 'tools/runtime/cli.js')), 'the declared include must land on the real target');

    assert.ok(!existsSync(join(hookRepo, '.git', 'info', 'sparse-checkout')), 'the hook repo must never gain a sparse-checkout');
    const hookRepoCone = git(hookRepo, ['config', '--default', 'false', '--get', 'core.sparseCheckoutCone']).trim();
    assert.equal(hookRepoCone, 'false', 'the hook repo must be untouched by the parent selection');
    assert.ok(
      existsSync(join(hookRepo, 'services/real-app/main.py')),
      'the hook repo\'s own tracked project files must stay visible',
    );
  });
});
