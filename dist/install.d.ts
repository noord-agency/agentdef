export interface InstallResult {
    installed: string[];
}
export declare function install(dir: string, opts?: {
    force?: boolean;
}): InstallResult;
