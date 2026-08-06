// Regression coverage for the bug this module exists to fix: a git hook
// (post-merge/post-checkout/post-rewrite) runs with GIT_DIR and GIT_WORK_TREE
// set in its own environment, pointing at the repo/worktree that triggered it.
// Every git subprocess agentdef spawns must ignore those ambient vars so a
// `-C <dir>` (or plain cwd) argument stays authoritative — see
// install.hook-env-leak.test.ts for the end-to-end reproduction.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gitSubprocessEnv } from '../src/git-env.js';

describe('gitSubprocessEnv', () => {
  test('strips every ambient git repo-location variable', () => {
    const before = {
      ...process.env,
      GIT_DIR: '/some/hook/repo/.git',
      GIT_WORK_TREE: '/some/hook/repo',
      GIT_INDEX_FILE: '/some/hook/repo/.git/index',
      GIT_COMMON_DIR: '/some/hook/repo/.git',
      GIT_OBJECT_DIRECTORY: '/some/hook/repo/.git/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/other/objects',
      GIT_CEILING_DIRECTORIES: '/some',
    };
    const restore = { ...process.env };
    Object.assign(process.env, before);
    try {
      const env = gitSubprocessEnv();
      for (const key of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_COMMON_DIR',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_CEILING_DIRECTORIES',
      ]) {
        assert.equal(env[key], undefined, `${key} must be stripped`);
      }
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, restore);
    }
  });

  test('leaves unrelated environment variables untouched', () => {
    const before = process.env.PATH;
    const env = gitSubprocessEnv();
    assert.equal(env.PATH, before);
  });
});
