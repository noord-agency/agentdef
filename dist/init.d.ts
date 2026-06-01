export interface InitResult {
    hooksDir: string;
    installed: string[];
    unsetHooksPath: boolean;
    gitignoreAdded: boolean;
    legacyRemoved: boolean;
}
export declare function init(dir: string): InitResult;
