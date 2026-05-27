import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { loadAgentManifest, loadFileIfExists } from '../loader.js';
import { loadAllSkills, getAllowedTools, type SkillFull } from '../skills.js';

// Cursor is the one tool needing real translation rather than a single file: it
// reads .cursor/rules/*.mdc, one always-applied global rule (SOUL + RULES) plus
// one rule per skill. Emitted as a multi-file stream the sync layer splits into
// files. Unlike the single-file adapters, Cursor does not read root SOUL/RULES.

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseGlobs(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(/[\s,]+/).map((g) => g.trim()).filter(Boolean);
}

function buildMdcFile(frontmatter: Record<string, unknown>, body: string): string {
  const fm = yaml.dump(frontmatter, { lineWidth: 120 }).trimEnd();
  return `---\n${fm}\n---\n\n${body.trim()}\n`;
}

interface Rule {
  filename: string;
  content: string;
}

function buildGlobalRule(agentDir: string, description: string): Rule | null {
  const soul = loadFileIfExists(join(agentDir, 'SOUL.md'));
  const rules = loadFileIfExists(join(agentDir, 'RULES.md'));
  if (!soul && !rules) return null;

  const body: string[] = [];
  if (soul) {
    body.push('## Identity & Soul', '', soul.trim());
  }
  if (rules) {
    if (body.length > 0) body.push('');
    body.push('## Rules & Constraints', '', rules.trim());
  }
  return {
    filename: `${slugify(description)}.mdc`,
    content: buildMdcFile({ description, alwaysApply: true }, body.join('\n')),
  };
}

function buildSkillRule(skill: SkillFull): Rule {
  const fm = skill.frontmatter;
  const frontmatter: Record<string, unknown> = {
    description: fm.description,
    alwaysApply: false,
  };
  const globs = parseGlobs((fm.metadata as Record<string, unknown> | undefined)?.['globs']);
  if (globs.length > 0) frontmatter['globs'] = globs;

  const body: string[] = [`# ${String(fm.name)}`, '', skill.instructions.trim()];
  const tools = getAllowedTools(fm);
  if (tools.length > 0) {
    body.push('', `**Allowed tools:** ${tools.join(', ')}`);
  }
  return {
    filename: `${slugify(String(fm.name))}.mdc`,
    content: buildMdcFile(frontmatter, body.join('\n')),
  };
}

export function exportToCursor(dir: string): string {
  const agentDir = resolve(dir);
  const manifest = loadAgentManifest(agentDir);

  const rules: Rule[] = [];
  // Note: the global rule is filenamed off the agent name in upstream; we follow
  // that, slugifying the manifest name for the always-applied rule.
  const globalRule = buildGlobalRule(agentDir, manifest.description);
  if (globalRule) {
    globalRule.filename = `${slugify(manifest.name)}.mdc`;
    rules.push(globalRule);
  }
  for (const skill of loadAllSkills(join(agentDir, 'skills'))) {
    rules.push(buildSkillRule(skill));
  }

  const parts: string[] = [];
  for (const rule of rules) {
    parts.push(`# === .cursor/rules/${rule.filename} ===`);
    parts.push(rule.content);
    parts.push('');
  }
  return `${parts.join('\n').trimEnd()}\n`;
}
