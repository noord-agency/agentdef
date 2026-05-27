import { join, resolve } from 'node:path';
import { loadAgentManifest, loadFileIfExists } from './loader.js';
import { resolveIdentity } from './merge.js';
import { loadAllSkills, getAllowedTools } from './skills.js';

// Shared builder for single-file instruction docs (AGENTS.md, GEMINI.md): one
// flat document with identity + SOUL + RULES + every skill inlined. Optional
// delegation (sub-agents) and memory sections are appended for tools that want
// them. Keeps AGENTS.md and GEMINI.md from drifting apart on the shared core.
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

  const skills = loadAllSkills(join(agentDir, 'skills'));
  if (skills.length > 0) {
    parts.push('## Skills');
    parts.push('');
    for (const skill of skills) {
      const tools = getAllowedTools(skill.frontmatter);
      const toolsNote = tools.length > 0 ? `\nAllowed tools: ${tools.join(', ')}` : '';
      parts.push(`### ${skill.frontmatter.name}`);
      parts.push(`${skill.frontmatter.description}${toolsNote}`);
      parts.push('');
      parts.push(skill.instructions);
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
