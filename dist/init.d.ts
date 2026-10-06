export interface HookRunner {
    node: string;
    cli: string;
}
export interface HookRunnerSource {
    platform?: NodeJS.Platform;
    execPath?: string;
    cliPath?: string;
}
export declare function hookRunner(source?: HookRunnerSource): HookRunner;
export declare const HOOK_NAMES: readonly ["post-merge", "post-checkout", "post-commit", "post-rewrite"];
export type HookName = (typeof HOOK_NAMES)[number];
export declare function buildHooks(knowledgeDir: string, runner: HookRunner): Record<HookName, string>;
export interface InitResult {
    hooksDir: string;
    installed: string[];
    unsetHooksPath: boolean;
    externalHooksPath: string;
    gitignoreAdded: boolean;
    legacyRemoved: boolean;
}
export declare function init(dir: string, runner?: HookRunner): InitResult;
export declare function refreshHooks(dir: string, runner?: HookRunner): HookName[];
