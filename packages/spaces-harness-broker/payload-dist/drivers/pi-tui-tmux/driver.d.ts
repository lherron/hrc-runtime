import type { TmuxExec } from '../../runtime/tmux';
import type { Driver } from '../driver';
import { type HookListenerHandle } from '../tmux-shared';
import type { PiTuiTmuxHookEnvelope } from './hook-ingestion';
export type PiHookListenerHandle = HookListenerHandle;
export interface PiHookListenerContext {
    invocationId: string;
    runtimeId?: string | undefined;
}
export type PiHookEnvelopeHandler = (envelope: PiTuiTmuxHookEnvelope) => Promise<void>;
export interface PiTuiTmuxDriverOptions {
    tmux: {
        socketPath?: string | undefined;
        tmuxBin?: string | undefined;
        exec?: TmuxExec | undefined;
    };
    hooks: {
        listen: (handler: PiHookEnvelopeHandler, context: PiHookListenerContext) => Promise<PiHookListenerHandle>;
        bridgeCommand?: string | undefined;
    };
    now?: (() => Date) | undefined;
}
export declare function createPiTuiTmuxDriver(options: PiTuiTmuxDriverOptions): Driver;
export declare function createDefaultPiTuiTmuxDriver(socketDir?: string): Driver;
export declare function buildPiHookSocketPath(socketDir: string, context: PiHookListenerContext): string;
//# sourceMappingURL=driver.d.ts.map