import { join, resolve } from 'node:path';
import { loadAgentManifest, loadFileIfExists } from './loader.js';
import { resolveIdentity } from './merge.js';
import { collectSkillMetadata } from './skills.js';

// Shared builder for single-file instruction docs (AGENTS.md, GEMINI.md): one
// flat document with identity + SOUL + RULES + a skills INDEX (metadata + a
// pointer to each SKILL.md). Skills are NOT inlined: AGENTS.md-family tools and
// Gemini auto-load skills from their own skills dir (the Agent Skills standard),
// so inlining would only duplicate them and bloat the file. Same approach as
// CLAUDE.md. Optional delegation (sub-agents) and memory sections are appended
// for tools that want them. Keeps AGENTS.md and GEMINI.md from drifting apart.
export interface DocOptions {
  delegation?: boolean;
  memory?: boolean;
}

export function buildInstructionDoc(dir: string, opts: DocOptions = {}): string {
  const agentDir = resolve(dir);
  const manifest = loadAgentManifest(agentDir);
  const { soul, rules } = resolveIdentity(agentDir);

  const parts: string[] = [];
  parts.push(`# ${manifest.name}`);
  parts.push(`${manifest.description}`);
  parts.push('');
  if (soul) {
    parts.push(soul);
    parts.push('');
  }
  if (rules) {
    parts.push(rules);
    parts.push('');
  }

  const duty = loadFileIfExists(join(agentDir, 'DUTIES.md'));
  if (duty) {
    parts.push(duty);
    parts.push('');
  }

  const skills = collectSkillMetadata(agentDir);
  if (skills.length > 0) {
    parts.push('## Skills');
    parts.push('');
    for (const skill of skills) {
      const skillDirName = skill.directory.split('/').pop();
      parts.push(`### ${skill.name}`);
      parts.push(skill.description);
      if (skill.allowedTools && skill.allowedTools.length > 0) {
        parts.push(`Allowed tools: ${skill.allowedTools.join(', ')}`);
      }
      parts.push(`Full instructions: \`skills/${skillDirName}/SKILL.md\``);
      parts.push('');
    }
  }

  if (opts.delegation && manifest.agents && Object.keys(manifest.agents).length > 0) {
    parts.push('## Delegation Pattern');
    parts.push('');
    parts.push('This agent uses sub-agents for specialized tasks:');
    parts.push('');
    for (const [name, config] of Object.entries(manifest.agents)) {
      parts.push(`### ${name}`);
      if (config.description) parts.push(config.description);
      if (config.delegation?.triggers) {
        parts.push(`Triggers: ${config.delegation.triggers.join(', ')}`);
      }
      parts.push('');
    }
  }

  if (opts.memory) {
    const memory = loadFileIfExists(join(agentDir, 'memory', 'MEMORY.md'));
    if (memory && memory.trim().split('\n').length > 2) {
      parts.push('## Memory');
      parts.push(memory);
      parts.push('');
    }
  }

  return `${parts.join('\n').trimEnd()}\n`;
}
