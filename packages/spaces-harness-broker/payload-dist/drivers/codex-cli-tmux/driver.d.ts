import type { TmuxExec } from '../../runtime/tmux';
import type { Driver } from '../driver';
import { type HookListenerHandle } from '../tmux-shared';
import { type CodexCliTmuxHookEnvelope } from './hook-events';
export type CodexHookListenerHandle = HookListenerHandle;
/**
 * Per-invocation/runtime identity handed to the hook listener so a durable
 * broker binds a UNIQUE callback socket per invocation under its runtime hooks
 * dir (T-01794 Phase D) — never the legacy single global codex-hooks.sock.
 */
export interface CodexHookListenerContext {
    invocationId: string;
    runtimeId?: string | undefined;
}
export type CodexHookEnvelopeHandler = (envelope: CodexCliTmuxHookEnvelope) => Promise<void>;
export interface CodexCliTmuxDriverOptions {
    tmux: {
        socketPath: string;
        tmuxBin?: string | undefined;
        exec?: TmuxExec | undefined;
    };
    hooks: {
        listen: (handler: CodexHookEnvelopeHandler, context: CodexHookListenerContext) => Promise<CodexHookListenerHandle>;
        /**
         * Broker-owned receiver command invoked by the generated HRC_LAUNCH_HOOK_CLI
         * wrapper. Defaults to the installed `harness-broker codex-hook` CLI.
         */
        bridgeCommand?: string | undefined;
    };
    now?: (() => Date) | undefined;
}
export declare function createCodexCliTmuxDriver(options: CodexCliTmuxDriverOptions): Driver;
export declare function createDefaultCodexCliTmuxDriver(socketDir?: string): Driver;
/**
 * Build a SHORT, per-invocation/runtime codex hook socket path under
 * `socketDir`. Mirrors `buildClaudeHookSocketPath`: a 16-hex digest of
 * invocationId+runtimeId keeps the basename short so the relocated socket and
 * its derived wrapper/launch-artifact paths stay within the unix socket path
 * budget (Phase B).
 */
export declare function buildCodexHookSocketPath(socketDir: string, context: CodexHookListenerContext): string;
//# sourceMappingURL=driver.d.ts.map