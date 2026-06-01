export interface SyncResult {
    adapters: string[];
    written: string[];
    warnings: string[];
}
export declare function sync(dir: string, opts?: {
    adapters?: string[];
}): SyncResult;
