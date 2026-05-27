import type { SkillMetadata } from './types.js';
export interface SkillFull {
    frontmatter: Record<string, unknown>;
    instructions: string;
    directory: string;
}
export declare function getAllowedTools(frontmatter: Record<string, unknown>): string[];
export declare function loadSkillMetadata(filePath: string): SkillMetadata;
export declare function parseSkillMd(filePath: string): SkillFull;
export declare function loadAllSkillMetadata(skillsDir: string): SkillMetadata[];
export declare function loadAllSkills(skillsDir: string): SkillFull[];
export declare function collectSkillMetadata(agentDir: string): SkillMetadata[];
export declare function collectSkills(agentDir: string): SkillFull[];
