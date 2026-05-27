import { readdirSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { collectSourceRoots } from './sources.js';

// Mirror skill directories (skills/<name>/) from all sources into a tool's skill
// dir, local winning on name collision. Only directories are copied, so a
// `skills.md` folder note (a file) is naturally skipped.
export function mirrorSkillDirs(agentDir: string, targetRel: string): number {
  const target = join(resolve(agentDir), targetRel);
  rmSync(target, { recursive: true, force: true });
  const seen = new Set<string>();
  for (const root of collectSourceRoots(agentDir, 'skills')) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      seen.add(entry.name);
      mkdirSync(target, { recursive: true });
      cpSync(join(root, entry.name), join(target, entry.name), { recursive: true });
    }
  }
  return seen.size;
}

// Mirror agent definition files (agents/<name>.md) into a tool's agents dir,
// local winning. Skips the `[folder].md` folder note (e.g. agents/agents.md),
// which is documentation, not a subagent.
export function mirrorAgentFiles(agentDir: string, targetRel: string): number {
  const target = join(resolve(agentDir), targetRel);
  rmSync(target, { recursive: true, force: true });
  const seen = new Set<string>();
  for (const root of collectSourceRoots(agentDir, 'agents')) {
    const folderNote = `${basename(root)}.md`; // e.g. agents.md inside agents/
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name === folderNote || seen.has(entry.name)) continue;
      seen.add(entry.name);
      mkdirSync(target, { recursive: true });
      cpSync(join(root, entry.name), join(target, entry.name));
    }
  }
  return seen.size;
}
