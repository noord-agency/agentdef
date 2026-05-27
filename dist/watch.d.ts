export interface WatchSource {
    name: string;
    url: string;
}
export interface WatchResult {
    added: string[];
    changed: string[];
    unchanged: string[];
}
export declare function watch(sources: WatchSource[], baselinePath: string, opts?: {
    update?: boolean;
}): Promise<WatchResult>;
