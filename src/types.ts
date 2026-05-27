// Minimal manifest + skill types for the formats agentdef actually emits.
// Compliance/SOD/knowledge-index fields from the upstream spec are intentionally
// omitted: noord does not use them, so the adapters never read them.

export interface AgentEntry {
  description?: string;
  delegation?: { triggers?: string[] };
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
