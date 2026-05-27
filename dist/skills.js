import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
// The `allowed-tools` frontmatter value is a whitespace-delimited string.
// Splitting on whitespace (not commas) preserves whatever punctuation authors
// wrote, which is what reproduces the existing output verbatim.
export function getAllowedTools(frontmatter) {
    const tools = frontmatter['allowed-tools'];
    if (typeof tools !== 'string' || tools.trim() === '')
        return [];
    return tools.split(/\s+/).filter(Boolean);
}
// Lightweight: frontmatter only (name, description, allowed-tools). Used for the
// CLAUDE.md skills index, where Claude Code loads each SKILL.md on demand.
export function loadSkillMetadata(filePath) {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
        throw new Error(`SKILL.md at ${filePath} is missing YAML frontmatter (---)`);
    }
    const fm = yaml.load(match[1]);
    if (!fm?.name || !fm?.description) {
        throw new Error(`SKILL.md at ${filePath} is missing required fields: name, description`);
    }
    const tools = getAllowedTools(fm);
    return {
        name: String(fm.name),
        description: String(fm.description),
        license: fm.license ? String(fm.license) : undefined,
        allowedTools: tools.length > 0 ? tools : undefined,
        directory: join(filePath, '..'),
    };
}
// Full: frontmatter + the instruction body. Used for AGENTS.md, which inlines
// every skill because tools read it as a single file.
export function parseSkillMd(filePath) {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---\n*([\s\S]*)$/);
    if (!match) {
        throw new Error(`SKILL.md at ${filePath} is missing YAML frontmatter (---)`);
    }
    const frontmatter = yaml.load(match[1]);
    if (!frontmatter?.name || !frontmatter?.description) {
        throw new Error(`SKILL.md at ${filePath} is missing required fields: name, description`);
    }
    return { frontmatter, instructions: match[2].trim(), directory: join(filePath, '..') };
}
// Iterate skills/<name>/SKILL.md. Unlike upstream, which silently swallows parse
// errors, we let them throw: per noord's fail-loud rule a broken skill must
// surface, not vanish. All current skills parse, so output matches the reference.
function eachSkill(skillsDir, parse) {
    if (!existsSync(skillsDir))
        return [];
    const out = [];
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const skillMd = join(skillsDir, entry.name, 'SKILL.md');
        if (!existsSync(skillMd))
            continue;
        out.push(parse(skillMd));
    }
    return out;
}
export function loadAllSkillMetadata(skillsDir) {
    return eachSkill(skillsDir, loadSkillMetadata);
}
export function loadAllSkills(skillsDir) {
    return eachSkill(skillsDir, parseSkillMd);
}
