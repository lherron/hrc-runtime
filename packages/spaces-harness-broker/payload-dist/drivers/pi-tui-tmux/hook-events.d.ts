import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol';
import type { PiTuiTmuxHookEnvelope } from './hook-ingestion';
export declare const PI_TUI_TMUX_DRIVER_KIND = "pi-tui-tmux";
export type PiTuiTmuxHookEventNormalizer = {
    normalizeHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[];
};
export type PiTuiTmuxHookEventNormalizerOptions = {
    invocationId: string;
    now: () => Date;
    allocateTurnId?: (() => string) | undefined;
};
export type NormalizePiHookEnvelopeOptions = {
    normalizer?: PiTuiTmuxHookEventNormalizer | undefined;
    now?: (() => Date) | undefined;
};
export declare function normalizePiHookEnvelope(envelope: PiTuiTmuxHookEnvelope, options?: NormalizePiHookEnvelopeOptions): InvocationEventEnvelope[];
export declare function createPiTuiTmuxHookEventNormalizer(options: PiTuiTmuxHookEventNormalizerOptions): PiTuiTmuxHookEventNormalizer;
//# sourceMappingURL=hook-events.d.ts.map