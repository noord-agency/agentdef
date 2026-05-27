export interface InitResult {
    hooksDir: string;
    installed: string[];
    unsetHooksPath: boolean;
}
export declare function init(dir: string): InitResult;
