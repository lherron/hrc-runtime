import type { HarnessInvocationSpec, InvocationInput } from 'spaces-harness-broker-protocol';
import { shellQuote } from '../runtime/shell-quote';
import { type TmuxExec, TmuxPaneController } from '../runtime/tmux';
import type { DriverContext } from './driver';
export { shellQuote };
/** Concatenate the text parts of an invocation input into a single string. */
export declare function extractText(input: InvocationInput): string;
/** Sleep helper shared by the tmux drivers' input-delivery paths. */
export declare function sleep(ms: number): Promise<void>;
/**
 * SessionEnd reasons that mean the OPERATOR deliberately ended the conversation,
 * so the captured continuation must be dropped (next launch is fresh). An
 * external pane-kill / crash reports `other` (or fires no SessionEnd at all) and
 * is intentionally absent here, so `--resume` durability survives pane
 * recreation (T-01761 ariadne case). Shared by both tmux drivers so HRC's
 * continuation.cleared -> broker-tmux lease reap fires identically for each.
 *
 * NOTE: invocation-manager's SESSION_LEAVE_REASONS is a deliberately smaller set
 * (no `clear`) and is intentionally NOT this constant.
 */
export declare const USER_INITIATED_END_REASONS: Set<string>;
/** Read the invocation's runtime id off the spec's correlation map, if present. */
export declare function getInvocationRuntimeId(spec: HarnessInvocationSpec): string | undefined;
/**
 * Build a SHORT, per-invocation/runtime hook socket path under `socketDir`. A
 * 16-hex digest of invocationId+runtimeId keeps the basename short so the
 * relocated socket and its derived wrapper/launch-artifact paths stay within
 * the unix socket path budget.
 */
export declare function buildHookSocketPath(socketDir: string, prefix: string, context: {
    invocationId: string;
    runtimeId?: string | undefined;
}): string;
/** Handle returned by a hook callback listener bound to a broker socket. */
export interface HookListenerHandle {
    socketPath: string;
    close: () => Promise<void>;
}
export type HookEnvelopeDecision = Record<string, unknown>;
export type HookEnvelopeResult = HookEnvelopeDecision | undefined;
/**
 * Bind a Unix-domain socket server that accepts a single JSON envelope per
 * connection, parses it, and hands it to `handler`. Shared by both tmux drivers;
 * the envelope type is supplied by the caller.
 */
export declare function listenForHookEnvelopes<TEnvelope>(socketPath: string, handler: (envelope: TEnvelope) => Promise<unknown> | unknown): Promise<HookListenerHandle>;
/** Surface ids reported by a consumed pane lease. */
export interface PaneLeaseSurface {
    socketPath: string;
    sessionId: string;
    windowId: string;
    paneId: string;
    sessionName?: string | undefined;
    windowName?: string | undefined;
}
export interface ConsumePaneLeaseResult {
    controller: TmuxPaneController;
    surface: PaneLeaseSurface;
}
/**
 * Validate the runtime pane lease shape (`runtime.terminalSurface`), construct a
 * {@link TmuxPaneController} against it, inspect the pane, and assert the tmux
 * server's reported ids match the lease. Throws a {@link BrokerError} on any
 * shape/identity mismatch. Shared by both tmux drivers' `start()`.
 */
export declare function consumePaneLease(driverCtx: DriverContext, opts: {
    driverKind: string;
    tmuxBin?: string | undefined;
    exec?: TmuxExec | undefined;
}): Promise<ConsumePaneLeaseResult>;
//# sourceMappingURL=tmux-shared.d.ts.map