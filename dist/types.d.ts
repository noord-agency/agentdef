export interface AgentEntry {
    description?: string;
    delegation?: {
        triggers?: string[];
    };
}
export interface AgentManifest {
    name: string;
    description: string;
    version?: string;
    extends?: string;
    model?: {
        preferred?: string;
        fallback?: string[];
    };
    agents?: Record<string, AgentEntry>;
}
export interface SkillMetadata {
    name: string;
    description: string;
    license?: string;
    allowedTools?: string[];
    directory: string;
}
