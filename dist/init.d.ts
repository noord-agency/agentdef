export interface InitResult {
    hooksDir: string;
    installed: string[];
    unsetHooksPath: boolean;
    externalHooksPath: string;
    gitignoreAdded: boolean;
    legacyRemoved: boolean;
}
export declare function init(dir: string): InitResult;
