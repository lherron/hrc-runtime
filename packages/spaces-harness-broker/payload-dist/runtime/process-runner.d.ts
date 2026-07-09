import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HarnessProcessSpec } from 'spaces-harness-broker-protocol';
import type { DispatchEnv } from './env';
export interface SpawnEnvChannels {
    /** Driver-provided credential env. Empty for the codex driver (auth on disk). */
    credentials?: Record<string, string> | undefined;
    /** Per-invocation env from the InvocationDispatchRequest envelope. */
    dispatchEnv?: DispatchEnv | undefined;
}
export declare function spawnHarnessProcess(spec: HarnessProcessSpec, channels?: SpawnEnvChannels): Promise<ChildProcessWithoutNullStreams>;
//# sourceMappingURL=process-runner.d.ts.map