import { join, resolve } from 'node:path';
import { loadAgentManifest, loadFileIfExists } from '../loader.js';
import { resolveIdentity } from '../merge.js';
import { collectSkillMetadata } from '../skills.js';
// Emits CLAUDE.md: identity + SOUL + RULES + a skills index (metadata plus a
// pointer to each SKILL.md, since Claude Code loads skills on demand) + the model
// hint. Compliance and knowledge-index sections from the upstream spec are
// dropped: noord uses neither.
export function exportToClaudeCode(dir) {
    const agentDir = resolve(dir);
    const manifest = loadAgentManifest(agentDir);
    const { soul, rules } = resolveIdentity(agentDir);
    const parts = [];
    parts.push(`# ${manifest.name}`);
    parts.push(`${manifest.description}\n`);
    if (soul)
        parts.push(soul);
    if (rules)
        parts.push(rules);
    const duty = loadFileIfExists(join(agentDir, 'DUTIES.md'));
    if (duty)
        parts.push(duty);
    const skills = collectSkillMetadata(agentDir);
    if (skills.length > 0) {
        const skillParts = ['## Skills\n'];
        for (const skill of skills) {
            const skillDirName = skill.directory.split('/').pop();
            skillParts.push(`### ${skill.name}`);
            skillParts.push(skill.description);
            if (skill.allowedTools && skill.allowedTools.length > 0) {
                skillParts.push(`Allowed tools: ${skill.allowedTools.join(', ')}`);
            }
            skillParts.push(`Full instructions: \`skills/${skillDirName}/SKILL.md\``);
            skillParts.push('');
        }
        parts.push(skillParts.join('\n'));
    }
    if (manifest.model?.preferred) {
        parts.push(`<!-- Model: ${manifest.model.preferred} -->`);
    }
    return parts.join('\n\n');
}
