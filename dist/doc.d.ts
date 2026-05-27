export interface DocOptions {
    delegation?: boolean;
    memory?: boolean;
}
export declare function buildInstructionDoc(dir: string, opts?: DocOptions): string;
