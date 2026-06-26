export declare const KNOWN_ADAPTERS: Set<string>;
export declare function machineAdaptersPath(): string;
export type AdapterSource = 'flag' | 'repo' | 'machine' | 'none';
export interface ResolvedAdapters {
    adapters: string[];
    source: AdapterSource;
    path?: string;
}
export declare function resolveAdapters(agentDir: string, override?: string[]): ResolvedAdapters;
export declare function writeAdapters(tools: string[], opts: {
    local: boolean;
    dir: string;
}): {
    path: string;
    unknown: string[];
};
export interface SyncResult {
    adapters: string[];
    written: string[];
    warnings: string[];
}
export declare function sync(dir: string, opts?: {
    adapters?: string[];
}): SyncResult;
