import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadFileIfExists } from './loader.js';
// Resolve SOUL/RULES for an agent, applying parent inheritance when an installed
// extends-parent is present: SOUL replaces (child wins), RULES are the union with
// the parent's first. Shared by every adapter so AGENTS.md and CLAUDE.md inherit
// identically. (Upstream only merged inside the claude-code adapter; this unifies
// it so the formats can never drift apart on inheritance.)
export function resolveIdentity(agentDir) {
    const dir = resolve(agentDir);
    const parentDir = join(dir, '.gitagent', 'parent');
    const hasParent = existsSync(parentDir) && existsSync(join(parentDir, 'agent.yaml'));
    const childSoul = loadFileIfExists(join(dir, 'SOUL.md'));
    const childRules = loadFileIfExists(join(dir, 'RULES.md'));
    if (!hasParent)
        return { soul: childSoul, rules: childRules };
    const parentSoul = loadFileIfExists(join(parentDir, 'SOUL.md'));
    const parentRules = loadFileIfExists(join(parentDir, 'RULES.md'));
    const soul = childSoul ?? parentSoul;
    const rules = parentRules && childRules
        ? `${parentRules}\n\n${childRules}`
        : (childRules ?? parentRules);
    return { soul, rules };
}
