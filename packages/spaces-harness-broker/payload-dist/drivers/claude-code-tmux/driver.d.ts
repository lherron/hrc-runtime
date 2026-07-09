import type { TmuxExec } from '../../runtime/tmux';
import type { Driver } from '../driver';
import { type HookEnvelopeResult, type HookListenerHandle } from '../tmux-shared';
import { type ClaudeCodeHookEnvelope } from './hook-events';
export type { HookListenerHandle };
export interface HookListenerContext {
    invocationId: string;
    runtimeId?: string | undefined;
}
/** Receives normalized hook envelopes posted by the in-pane Claude hook CLI. */
export type HookEnvelopeHandler = (envelope: ClaudeCodeHookEnvelope) => Promise<HookEnvelopeResult> | HookEnvelopeResult;
export interface ClaudeCodeTmuxDriverOptions {
    tmux: {
        /**
         * Default tmux server socket — IGNORED by the lease-consuming driver path
         * (Phase C, T-01725). Retained on the options shape only for backward
         * compatibility with construction sites that still pass it; the live
         * socket is ALWAYS `runtime.terminalSurface.socketPath` from the pane
         * lease handed in on start.
         */
        socketPath?: string | undefined;
        tmuxBin?: string | undefined;
        exec?: TmuxExec | undefined;
    };
    hooks: {
        listen: (handler: HookEnvelopeHandler, context: HookListenerContext) => Promise<HookListenerHandle>;
        /**
         * Executable that the in-pane Claude hook settings overlay invokes to POST
         * each hook payload to the broker callback socket. Broker-owned (H3); no
         * hrc-runtime dependency. Defaults to the broker's `claude-hook` subcommand.
         */
        bridgeCommand?: string | undefined;
    };
    now?: (() => Date) | undefined;
}
/**
 * Phase 3 broker driver: launches an OPERATOR-ATTACHABLE interactive Claude
 * Code in a tmux session (pty transport, terminal host = tmux), delivers turns
 * via send-keys, normalizes the out-of-band Claude hook stream into broker
 * events, and reports the runtime tmux attach surface.
 *
 * AD-008: NO live reattach / NO event replay / NO claim HRC can recover a broker
 * invocation after restart — operator attach is plain `tmux attach`.
 */
export declare function createClaudeCodeTmuxDriver(options: ClaudeCodeTmuxDriverOptions): Driver;
/**
 * Build the Claude Code `--settings` overlay (H1). Env vars alone do NOT make
 * Claude invoke hooks; the runtime needs an actual `hooks` settings block whose
 * commands POST each hook payload to the broker callback socket. The bridge
 * command reads the hook JSON on stdin and the `HARNESS_BROKER_*` env to build
 * the envelope, then writes it to the callback socket (broker-owned, H3).
 */
export declare function buildClaudeHookSettingsOverlay(options: {
    callbackSocket: string;
    bridgeCommand?: string | undefined;
}): {
    hooks: Record<string, unknown>;
};
/**
 * Default-configured driver for registry registration. Uses the real tmux
 * binary and a real Unix-domain hook callback socket. The socket is bound
 * lazily inside `start()` (construction is side-effect-free), so registering
 * this driver performs no I/O. T-01725: no default tmux socket — the live
 * pane lease (`runtime.terminalSurface`) supplies it on start.
 */
export declare function createDefaultClaudeCodeTmuxDriver(socketDir?: string): Driver;
export declare function buildClaudeHookSocketPath(socketDir: string, context: HookListenerContext): string;
//# sourceMappingURL=driver.d.ts.map