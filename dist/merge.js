import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadFileIfExists } from './loader.js';
import { AGENTDEF_DIR } from './paths.js';
// Resolve SOUL/RULES for an agent across the whole extends chain. SOUL replaces:
// the nearest agent that defines one wins (local over parent over grandparent).
// RULES are the union, furthest ancestor first so the local agent's rules come
// last. Shared by every adapter so AGENTS.md and CLAUDE.md inherit identically.
// (Upstream only merged inside the claude-code adapter; this unifies it so the
// formats can never drift apart on inheritance.)
export function resolveIdentity(agentDir) {
    const souls = [];
    const ruleParts = [];
    let dir = resolve(agentDir);
    // Walk the chain nearest-first; it terminates at the first level with no valid
    // materialized parent. (Cycles are caught at install time.)
    for (;;) {
        const soul = loadFileIfExists(join(dir, 'SOUL.md'));
        if (soul != null)
            souls.push(soul);
        const rules = loadFileIfExists(join(dir, 'RULES.md'));
        if (rules != null)
            ruleParts.push(rules);
        const parent = join(dir, AGENTDEF_DIR, 'parent');
        if (!existsSync(join(parent, 'agent.yaml')))
            break;
        dir = parent;
    }
    const soul = souls.length > 0 ? souls[0] : null;
    const rules = ruleParts.length > 0 ? [...ruleParts].reverse().join('\n\n') : null;
    return { soul, rules };
}
