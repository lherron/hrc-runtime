import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol';
/**
 * T-04906 / T-04909 Phase B — the Codex app-server operator renderer.
 *
 * The renderer is a DRIVER-OWNED presentation process launched into the
 * HRC-leased `tmux-tui` pane. Its single source of truth is the broker's
 * DURABLE read surface (daedalus Q1 ruling): it bootstraps from
 * `invocation.eventsSince`, then consumes live `invocation.event`
 * notifications. It is NOT fed a driver-pushed private event stream, so its
 * output stays coherent with HRC durable attach/replay semantics. The
 * app-server JSON-RPC stdio child remains the authoritative harness transport;
 * the renderer never replaces it and never routes through `codex-cli-tmux`.
 */
export interface RendererEventsSinceRequest {
    invocationId: string;
    afterSeq: number;
}
export interface RendererEventsSinceResponse {
    events: InvocationEventEnvelope[];
    currentSeq: number;
    retentionFloorSeq?: number | undefined;
}
/**
 * The durable broker read surface the renderer projects from. Backed in
 * production by the read-only observer/broker JSON-RPC socket (`eventsSince` +
 * the `invocation.event` notification stream); backed in tests by an in-memory
 * fake. It is deliberately read-only — mutation (e.g. Phase C `/quit`) does NOT
 * flow through here.
 */
export interface RendererDurableReadSurface {
    eventsSince: (request: RendererEventsSinceRequest) => Promise<RendererEventsSinceResponse>;
    observe: (handler: (event: InvocationEventEnvelope) => void) => {
        close: () => void;
    };
}
export interface RendererProjection {
    /** Bootstrap from `eventsSince`, then stream live `invocation.event`. */
    start: () => Promise<void>;
    /** The rendered transcript lines, in seq order. */
    lines: () => string[];
    close: () => void;
}
export interface RendererProjectionOptions {
    invocationId: string;
    readSurface: RendererDurableReadSurface;
    /** Optional side-channel for each rendered line (e.g. write to the pane). */
    sink?: (line: string) => void;
    /** Emit ANSI colour (default false — enable on a TTY pane). */
    color?: boolean | undefined;
    /** Wrap width for assistant prose (default 96). */
    width?: number | undefined;
}
/**
 * Build the durable-read projection for one invocation. Live subscription is
 * established BEFORE the `eventsSince` bootstrap so no event slips through the
 * gap between the replay snapshot and the live stream; any replay/live overlap
 * (and any out-of-order live arrival during bootstrap) is reconciled by seq so
 * output is de-duplicated and strictly seq-ordered.
 */
export declare function createCodexAppServerRendererProjection(options: RendererProjectionOptions): RendererProjection;
/**
 * Render a durable-read failure VISIBLY (daedalus invariant): a retention-gap
 * (`EventReplayUnavailable`) or any other read-surface error must surface in
 * the renderer output, never be silently dropped.
 */
export declare function formatReadFailure(error: unknown): string;
/**
 * Resolve the absolute path to the renderer entry process that ships beside
 * this module (`renderer-entry.ts` in dev, `.js` once built by tsc). The launch
 * command invokes it directly inside the leased pane.
 */
export declare function resolveRendererEntryPath(): string;
export interface RendererLaunchOptions {
    invocationId: string;
    /** Read-only observer/broker socket the renderer connects to. */
    observerSocketPath: string;
    /** Fenced renderer->driver control socket for lifecycle intent such as /quit. */
    controlSocketPath: string;
    runtimeId?: string | undefined;
    rendererEntryPath?: string | undefined;
}
/**
 * Build the command line pasted into the leased pane to launch the renderer.
 * It names the durable read source explicitly — bootstrap method
 * `invocation.eventsSince` and live notification `invocation.event` — so the
 * launch is self-documenting and a driver-pushed private feed can never satisfy
 * it. Never references `codex-cli-tmux`: the app-server JSON-RPC child stays the
 * harness transport.
 */
export declare function buildRendererLaunchCommand(options: RendererLaunchOptions): string;
//# sourceMappingURL=renderer.d.ts.map