import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadAgentManifest } from './loader.js';
import { loadAllSkills } from './skills.js';
// Model identifiers must be "provider:model" (e.g. anthropic:claude-opus-4-7).
// This is the exact rule the repurposed upstream package started enforcing, which
// broke CI; agentdef checks it explicitly.
const MODEL_RE = /^[a-z0-9-]+:.+$/;
export function validate(dir) {
    const agentDir = resolve(dir);
    const issues = [];
    let manifest;
    try {
        manifest = loadAgentManifest(agentDir);
    }
    catch (e) {
        return [{ level: 'error', message: e.message }];
    }
    if (!manifest.name) {
        issues.push({ level: 'error', message: 'agent.yaml: missing required field "name"' });
    }
    if (!manifest.description) {
        issues.push({ level: 'error', message: 'agent.yaml: missing required field "description"' });
    }
    const checkModel = (model, where) => {
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
    if (!existsSync(join(agentDir, 'SOUL.md'))) {
        issues.push({ level: 'warning', message: 'SOUL.md not found' });
    }
    // parseSkillMd throws on malformed frontmatter or missing name/description,
    // which surfaces here as an error rather than being silently skipped.
    try {
        loadAllSkills(join(agentDir, 'skills'));
    }
    catch (e) {
        issues.push({ level: 'error', message: `skills: ${e.message}` });
    }
    return issues;
}
