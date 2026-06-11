import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { loadAgentManifest } from '../loader.js';
import { resolveIdentity } from '../merge.js';
import { collectSkills, getAllowedTools } from '../skills.js';
// Cursor is the one tool needing real translation rather than a single file: it
// reads .cursor/rules/*.mdc, one always-applied global rule (SOUL + RULES) plus
// one rule per skill. `sync` writes these files directly; `export` emits them as
// a single stream. Unlike the single-file adapters, Cursor does not read root
// SOUL/RULES, so the global rule carries them.
function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}
function parseGlobs(raw) {
    if (typeof raw !== 'string' || raw.trim() === '')
        return [];
    return raw.split(/[\s,]+/).map((g) => g.trim()).filter(Boolean);
}
function buildMdcFile(frontmatter, body) {
    const fm = yaml.dump(frontmatter, { lineWidth: 120 }).trimEnd();
    return `---\n${fm}\n---\n\n${body.trim()}\n`;
}
function buildGlobalRule(agentDir, description) {
    const { soul, rules } = resolveIdentity(agentDir);
    if (!soul && !rules)
        return null;
    const body = [];
    if (soul) {
        body.push('## Identity & Soul', '', soul.trim());
    }
    if (rules) {
        if (body.length > 0)
            body.push('');
        body.push('## Rules & Constraints', '', rules.trim());
    }
    return {
        filename: `${slugify(description)}.mdc`,
        content: buildMdcFile({ description, alwaysApply: true }, body.join('\n')),
    };
}
function buildSkillRule(skill) {
    const fm = skill.frontmatter;
    const frontmatter = {
        description: fm.description,
        alwaysApply: false,
    };
    const globs = parseGlobs(fm.metadata?.['globs']);
    if (globs.length > 0)
        frontmatter['globs'] = globs;
    const body = [`# ${String(fm.name)}`, '', skill.instructions.trim()];
    const tools = getAllowedTools(fm);
    if (tools.length > 0) {
        body.push('', `**Allowed tools:** ${tools.join(', ')}`);
    }
    return {
        filename: `${slugify(String(fm.name))}.mdc`,
        content: buildMdcFile(frontmatter, body.join('\n')),
    };
}
function buildRules(dir) {
    const agentDir = resolve(dir);
    const manifest = loadAgentManifest(agentDir);
    const rules = [];
    const globalRule = buildGlobalRule(agentDir, manifest.description);
    if (globalRule) {
        globalRule.filename = `${slugify(manifest.name)}.mdc`;
        rules.push(globalRule);
    }
    for (const skill of collectSkills(agentDir)) {
        rules.push(buildSkillRule(skill));
    }
    return rules;
}
// For `agentdef sync`: the actual files to write, relative to the agent dir.
export function exportToCursorFiles(dir) {
    return buildRules(dir).map((rule) => ({
        path: `.cursor/rules/${rule.filename}`,
        content: rule.content,
    }));
}
// For `agentdef export -f cursor`: a single multi-file stream.
export function exportToCursor(dir) {
    const parts = [];
    for (const rule of buildRules(dir)) {
        parts.push(`# === .cursor/rules/${rule.filename} ===`);
        parts.push(rule.content);
        parts.push('');
    }
    return `${parts.join('\n').trimEnd()}\n`;
}
