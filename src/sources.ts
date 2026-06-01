import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AGENTDEF_DIR } from './paths.js';

// Collect the source roots for a given kind (skills, agents) across the whole
// extends chain, in precedence order: the agent itself first, then its parent,
// grandparent, and so on — each one level deeper under .agentdef/parent — plus
// any dependencies at each level. Callers dedupe by name with first-seen winning,
// so a nearer ancestor (and the local agent above all) shadows inherited ones on
// collision. A base repo with no extends yields just the local roots, unchanged.
export function collectSourceRoots(agentDir: string, kind: string): string[] {
  const roots: string[] = [];
  let dir = resolve(agentDir);

  // The chain is a finite nesting of materialized parents, so this terminates as
  // soon as a level has no valid parent. (Cycles are caught at install time.)
  for (;;) {
    const local = join(dir, kind);
    if (existsSync(local)) roots.push(local);

    const depsDir = join(dir, AGENTDEF_DIR, 'deps');
    if (existsSync(depsDir)) {
      for (const entry of readdirSync(depsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const depKind = join(depsDir, entry.name, kind);
        if (existsSync(depKind)) roots.push(depKind);
      }
    }

    const parent = join(dir, AGENTDEF_DIR, 'parent');
    if (!existsSync(join(parent, 'agent.yaml'))) break;
    dir = parent;
  }

  return roots;
}
