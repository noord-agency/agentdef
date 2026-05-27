export interface ValidationIssue {
    level: 'error' | 'warning';
    message: string;
}
export declare function validate(dir: string): ValidationIssue[];
