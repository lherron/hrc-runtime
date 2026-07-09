import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { BrokerErrorCode } from 'spaces-harness-broker-protocol';
import { BrokerError } from '../errors';
import { buildProcessEnv } from './env';
const liveChildren = new Set();
let exitHookInstalled = false;
export async function spawnHarnessProcess(spec, channels = {}) {
    if (spec.harnessTransport.kind !== 'jsonrpc-stdio') {
        throw new BrokerError(BrokerErrorCode.UnsupportedCapability, `Unsupported harness transport: ${spec.harnessTransport.kind}`);
    }
    const cwdStat = await stat(spec.cwd).catch((error) => {
        throw new BrokerError(BrokerErrorCode.ResourceError, `Invalid cwd: ${spec.cwd}`, {
            cwd: spec.cwd,
            cause: error instanceof Error ? error.message : String(error),
        });
    });
    if (!cwdStat.isDirectory()) {
        throw new BrokerError(BrokerErrorCode.ResourceError, `cwd is not a directory: ${spec.cwd}`, {
            cwd: spec.cwd,
        });
    }
    const command = spec.command ?? process.execPath;
    const proc = spawn(command, spec.args, {
        cwd: spec.cwd,
        env: buildProcessEnv({
            lockedEnv: spec.lockedEnv,
            credentials: channels.credentials,
            dispatchEnv: channels.dispatchEnv,
            pathPrepend: spec.pathPrepend,
        }),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    trackChild(proc);
    return proc;
}
function trackChild(proc) {
    liveChildren.add(proc);
    proc.once('exit', () => {
        liveChildren.delete(proc);
    });
    if (exitHookInstalled)
        return;
    exitHookInstalled = true;
    process.once('exit', () => {
        for (const child of liveChildren) {
            if (child.exitCode === null) {
                child.kill('SIGTERM');
            }
        }
    });
}
//# sourceMappingURL=process-runner.js.map