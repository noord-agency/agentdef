// Regression coverage for "agentdef validate is green, agentdef sync fails on
// the same repo". Every adapter reads skills through collectSkills, which walks
// the local skills/ plus .agentdef/parent and deps, while validate parsed only
// the local directory. A repo whose inherited skill was broken passed its own
// check and then failed on the next sync, with an error pointing into a
// directory nobody in that repo had written.
//
// The knowledge check sitting a few lines below it in validate.ts was chain-wide
// from the start. This is the two of them agreeing.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { validate } from '../src/validate.js';

// Fixtures are the MATERIALIZED layout (.agentdef/parent already on disk), the
// same shape the collectors see after a sync.
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agentdef-validate-test-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const BASE = {
  'agent.yaml': 'name: child\ndescription: test agent\n',
  'SOUL.md': '# soul\n',
  '.agentdef/parent/agent.yaml': 'name: parent\ndescription: parent agent\n',
};
const GOOD = '---\nname: inherited\ndescription: d\n---\nbody\n';
const NO_DESCRIPTION = '---\nname: inherited\n---\nbody\n';

const skillIssues = (dir: string) => validate(dir).filter((i) => i.message.startsWith('skills:'));

describe('validate reads skills the way sync does', () => {
  test('a broken inherited skill is an error, not a green run', () => {
    const root = fixture({
      ...BASE,
      '.agentdef/parent/skills/inherited/SKILL.md': NO_DESCRIPTION,
    });

    const issues = skillIssues(root);
    assert.equal(issues.length, 1, 'the inherited skill must be checked at all');
    assert.match(issues[0].message, /missing required fields: name, description/);
    // Nobody can fix this where it is reported: the next sync overwrites
    // .agentdef/. Without the pointer the reader edits the copy.
    assert.match(issues[0].hint ?? '', /parent repo/);
  });

  test('a broken local skill is reported without the parent pointer', () => {
    const root = fixture({
      ...BASE,
      'skills/own/SKILL.md': NO_DESCRIPTION,
    });

    const issues = skillIssues(root);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].hint, undefined, 'a local skill is fixed right here');
  });

  test('a healthy chain reports nothing about skills', () => {
    const root = fixture({
      ...BASE,
      'skills/own/SKILL.md': '---\nname: own\ndescription: d\n---\nbody\n',
      '.agentdef/parent/skills/inherited/SKILL.md': GOOD,
    });

    assert.deepEqual(skillIssues(root), []);
  });
});
