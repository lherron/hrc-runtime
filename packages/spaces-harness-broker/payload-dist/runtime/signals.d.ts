import type { ChildProcessWithoutNullStreams } from 'node:child_process';
export interface TerminateProcessOptions {
    proc: ChildProcessWithoutNullStreams;
    graceMs: number;
}
export declare function terminateProcess({ proc, graceMs }: TerminateProcessOptions): Promise<void>;
//# sourceMappingURL=signals.d.ts.map