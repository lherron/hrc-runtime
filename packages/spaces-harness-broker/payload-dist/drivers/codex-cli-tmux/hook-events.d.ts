import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol';
export declare const CODEX_CLI_TMUX_DRIVER_KIND = "codex-cli-tmux";
export type CodexCliTmuxHookEventNormalizer = {
    normalizeHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[];
};
export type CodexCliTmuxHookEventNormalizerOptions = {
    invocationId: string;
    now: () => Date;
};
export type CodexCliTmuxHookEnvelope = {
    invocationId?: string | undefined;
    generation?: number | undefined;
    callbackSocket?: string | undefined;
    runtimeId?: string | undefined;
    turnId?: string | undefined;
    hookData?: unknown;
    hookEvent?: unknown;
    payload?: unknown;
};
export type NormalizeCodexHookEnvelopeOptions = {
    normalizer?: CodexCliTmuxHookEventNormalizer | undefined;
    now?: (() => Date) | undefined;
};
/**
 * Resolve the base hook record carried by a codex-cli-tmux hook envelope: the
 * raw hook arrives under `hookData`, an alternate `hookEvent`, or `payload`,
 * falling back to the envelope itself. This is the one piece shared verbatim by
 * the driver's {@link extractCodexHookRecord} and {@link normalizeCodexHookEnvelope};
 * each then applies its OWN, intentionally divergent unwrap (the driver descends
 * a nested `hookEvent`; the normalizer merges the envelope turnId then defers to
 * `unwrapHookPayload`). Only this base resolution is consolidated — the divergent
 * tails are preserved.
 */
export declare function resolveCodexEnvelopeRecord(envelope: CodexCliTmuxHookEnvelope): Record<string, unknown>;
/**
 * Driver-side hook extraction: resolve the base record, then descend into a
 * nested `hookEvent` wrapper when the resolved record carries one. NOTE: this
 * intentionally differs from the normalizer's `unwrapHookPayload` (which prefers
 * a top-level `hook_event_name` over a nested one) — do NOT merge the two.
 */
export declare function extractCodexHookRecord(envelope: CodexCliTmuxHookEnvelope): Record<string, unknown>;
export declare function normalizeCodexHookEnvelope(envelope: CodexCliTmuxHookEnvelope, options?: NormalizeCodexHookEnvelopeOptions): InvocationEventEnvelope[];
export declare function createCodexCliTmuxHookEventNormalizer(options: CodexCliTmuxHookEventNormalizerOptions): CodexCliTmuxHookEventNormalizer;
//# sourceMappingURL=hook-events.d.ts.map