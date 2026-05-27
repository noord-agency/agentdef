import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
export function loadAgentManifest(dir) {
    const agentPath = join(resolve(dir), 'agent.yaml');
    if (!existsSync(agentPath)) {
        throw new Error(`agent.yaml not found in ${resolve(dir)}`);
    }
    return yaml.load(readFileSync(agentPath, 'utf-8'));
}
export function loadFileIfExists(path) {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}
