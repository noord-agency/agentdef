import { join, resolve } from 'node:path';
import { loadAgentManifest } from './loader.js';
import { resolveIdentity } from './merge.js';
import { loadAllSkills } from './skills.js';

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
}

// Model identifiers must be "provider:model" (e.g. anthropic:claude-opus-4-7).
// This is the exact rule the repurposed upstream package started enforcing, which
// broke CI; agentdef checks it explicitly.
const MODEL_RE = /^[a-z0-9-]+:.+$/;

export function validate(dir: string): ValidationIssue[] {
  const agentDir = resolve(dir);
  const issues: ValidationIssue[] = [];

  let manifest;
  try {
    manifest = loadAgentManifest(agentDir);
  } catch (e) {
    return [{ level: 'error', message: (e as Error).message }];
  }

  if (!manifest.name) {
    issues.push({ level: 'error', message: 'agent.yaml: missing required field "name"' });
  }
  if (!manifest.description) {
    issues.push({ level: 'error', message: 'agent.yaml: missing required field "description"' });
  }

  const checkModel = (model: string | undefined, where: string) => {
    if (model && !MODEL_RE.test(model)) {
      issues.push({
        level: 'error',
        message: `agent.yaml: ${where} "${model}" must be "provider:model" (e.g. anthropic:claude-opus-4-7)`,
      });
    }
  };
  checkModel(manifest.model?.preferred, 'model.preferred');
  for (const fallback of manifest.model?.fallback ?? []) {
    checkModel(fallback, 'model.fallback');
  }

  // Chain-aware: a repo inheriting SOUL/RULES via extends is fine; only when the
  // whole chain resolves empty do adapters emit no identity (e.g. no Cursor
  // global rule), which would otherwise fail silently.
  const { soul, rules } = resolveIdentity(agentDir);
  if (!soul && !rules) {
    issues.push({
      level: 'warning',
      message:
        'no SOUL.md or RULES.md found, neither locally nor via the extends chain. Adapters will generate no identity (Cursor: no global rule)',
    });
  } else if (!soul) {
    issues.push({ level: 'warning', message: 'no SOUL.md found, neither locally nor via the extends chain' });
  }

  // parseSkillMd throws on malformed frontmatter or missing name/description,
  // which surfaces here as an error rather than being silently skipped.
  try {
    loadAllSkills(join(agentDir, 'skills'));
  } catch (e) {
    issues.push({ level: 'error', message: `skills: ${(e as Error).message}` });
  }

  return issues;
}
