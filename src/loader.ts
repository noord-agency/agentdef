import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { AgentManifest } from './types.js';

export function loadAgentManifest(dir: string): AgentManifest {
  const agentPath = join(resolve(dir), 'agent.yaml');
  if (!existsSync(agentPath)) {
    throw new Error(`agent.yaml not found in ${resolve(dir)}`);
  }
  return yaml.load(readFileSync(agentPath, 'utf-8')) as AgentManifest;
}

export function loadFileIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}
