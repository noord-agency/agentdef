// Regression coverage for "agentdef sync aborts on Windows with 'is missing
// YAML frontmatter (---)' while the frontmatter is plainly there". git checks an
// LF blob out as CRLF when core.autocrlf is on, which is the Windows default,
// and the frontmatter parsers matched ^---\n strictly. One \r was enough to make
// every SKILL.md and every knowledge doc in a repo fail at once, on one
// developer's machine and nowhere else.
//
// The fix belongs in the parser. The alternative in use until now was pinning
// eol=lf per path in a .gitattributes, in every repo that agentdef reads, which
// works right up to the first repo where somebody forgets it.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadSkillMetadata, parseSkillMd } from '../src/skills.js';
import { loadKnowledgeMetadata } from '../src/knowledge.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Both variants come from the same source string with the line endings swapped
// at the last moment: the two files must differ in nothing but \r, or the test
// stops being about line endings.
function fixture(rel: string, content: string, crlf: boolean): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentdef-crlf-test-'));
  dirs.push(root);
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, crlf ? content.replace(/\n/g, '\r\n') : content);
  return { root, path };
}

const SKILL = ['---', 'name: crlf-skill', 'description: d', '---', '', 'Body line one.', ''].join('\n');
const DOC = ['---', 'type: brand', 'title: Competitors', '---', '', 'Body.', ''].join('\n');

describe('frontmatter parsing does not depend on the checkout line endings', () => {
  for (const crlf of [false, true]) {
    const label = crlf ? 'CRLF (Windows checkout)' : 'LF';

    test(`loadSkillMetadata reads a ${label} SKILL.md`, () => {
      const md = loadSkillMetadata(fixture('skills/x/SKILL.md', SKILL, crlf).path);
      assert.equal(md.name, 'crlf-skill');
      assert.equal(md.description, 'd');
    });

    test(`parseSkillMd reads a ${label} SKILL.md, body included`, () => {
      const skill = parseSkillMd(fixture('skills/x/SKILL.md', SKILL, crlf).path);
      assert.equal(skill.frontmatter.name, 'crlf-skill');
      // The body matters as much as the frontmatter: a pattern that matched the
      // delimiters but swallowed the separator would leave every skill inlined
      // into AGENTS.md empty, with nothing failing to say so.
      assert.match(skill.instructions, /^Body line one\.$/m);
    });

    test(`loadKnowledgeMetadata reads a ${label} doc`, () => {
      const { root, path } = fixture('knowledge/brand/competitors.md', DOC, crlf);
      const doc = loadKnowledgeMetadata(path, root);
      assert.equal(doc.type, 'brand');
      assert.equal(doc.title, 'Competitors');
    });
  }

  // Tolerating \r must not slide into tolerating anything: a file that really
  // carries no frontmatter is the error this parser exists to raise, and both
  // line endings have to keep raising it.
  test('a file without frontmatter still fails, whichever line endings it has', () => {
    for (const crlf of [false, true]) {
      const { path } = fixture('skills/y/SKILL.md', 'no frontmatter here\n', crlf);
      assert.throws(() => loadSkillMetadata(path), /missing YAML frontmatter/);
    }
  });
});
