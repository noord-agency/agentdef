import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
// Collect the source roots for a given kind (skills, agents) in precedence order,
// local first, then the installed extends parent, then any dependencies. Callers
// dedupe by name with first-seen winning, so local shadows inherited on collision.
export function collectSourceRoots(agentDir, kind) {
    const dir = resolve(agentDir);
    const roots = [];
    const local = join(dir, kind);
    if (existsSync(local))
        roots.push(local);
    const parent = join(dir, '.gitagent', 'parent', kind);
    if (existsSync(parent))
        roots.push(parent);
    const depsDir = join(dir, '.gitagent', 'deps');
    if (existsSync(depsDir)) {
        for (const entry of readdirSync(depsDir, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const depKind = join(depsDir, entry.name, kind);
            if (existsSync(depKind))
                roots.push(depKind);
        }
    }
    return roots;
}
