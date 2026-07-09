import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol';
export declare const CLAUDE_CODE_TMUX_DRIVER_KIND = "claude-code-tmux";
export type ClaudeCodeHookEventNormalizer = {
    normalizeHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[];
    normalizeToolCallFailure: (failure: {
        turnId: string;
        toolCallId: string;
        name: string;
        message: string;
        code?: string | undefined;
        data?: unknown;
    }) => InvocationEventEnvelope;
};
export type ClaudeCodeHookEventNormalizerOptions = {
    invocationId: string;
    now: () => Date;
    /**
     * Shared per-invocation turn-id allocator (cody's blessed scheme, C-02755).
     * MUST be the SAME closure the driver's `applyInputNow` uses so manager-minted
     * and normalizer-minted ids never collide and stay monotonic in turn-open
     * order. When omitted a local fallback allocator is used (sufficient for the
     * one-shot `normalizeHookEnvelope` path, which always supplies a turn id).
     */
    allocateTurnId?: (() => string) | undefined;
};
/**
 * Hook envelope as delivered by the broker hook-ingestion callback socket
 * (`buildHookEnvelope`). The real Claude turn id lives at the ENVELOPE/env
 * level (`HARNESS_BROKER_TURN_ID`), NOT inside the raw hook JSON — Claude does
 * not emit `turn_id` in its hook payloads. `normalizeHookEnvelope` threads the
 * envelope turn id into normalization so turn lifecycle events carry it.
 */
export type ClaudeCodeHookEnvelope = {
    invocationId: string;
    generation: number;
    callbackSocket: string;
    runtimeId?: string | undefined;
    turnId?: string | undefined;
    hookData: unknown;
};
export type NormalizeHookEnvelopeOptions = {
    /**
     * Reuse a stateful normalizer across envelopes (preserves activeTurnId /
     * completed-turn dedup / monotonic sequence). When omitted a fresh one-shot
     * normalizer is created per call (sufficient because the envelope always
     * supplies the turn id).
     */
    normalizer?: ClaudeCodeHookEventNormalizer | undefined;
    now?: (() => Date) | undefined;
};
/**
 * Normalize a single hook envelope into broker events, using the ENVELOPE turn
 * id (cody's Phase 3 seam) when the raw hook payload omits `turn_id`.
 */
export declare function normalizeHookEnvelope(envelope: ClaudeCodeHookEnvelope, options?: NormalizeHookEnvelopeOptions): InvocationEventEnvelope[];
export declare function createClaudeCodeHookEventNormalizer(options: ClaudeCodeHookEventNormalizerOptions): ClaudeCodeHookEventNormalizer;
//# sourceMappingURL=hook-events.d.ts.map