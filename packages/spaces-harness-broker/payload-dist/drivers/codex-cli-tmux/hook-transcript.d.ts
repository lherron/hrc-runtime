import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol';
/**
 * Hook-driven Codex rollout transcript reader (T-01710).
 *
 * Codex CLI has no `MessageDisplay`-equivalent hook, so the rollout transcript
 * JSONL is still the only source for interim agent prose. The defect this
 * replaces was a `setInterval` polling tailer that raced hook normalization;
 * this reader instead reads newly appended transcript bytes SYNCHRONOUSLY from
 * hook processing, in hook order, mirroring Claude's MessageDisplay held-latest
 * semantics: the latest agent message is held, superseded interims flush as
 * `assistant.message.completed{final:false}`, and the terminal message flushes
 * as `{final:true}` exactly once when the turn's `Stop` hook arrives.
 *
 * The driver calls {@link CodexHookTranscriptReader.handleHook} before
 * `normalizeCodexHookEnvelope`, emits the returned assistant-message events,
 * then emits the normalized hook events — so interim prose lands before the
 * triggering hook's event and the terminal message lands before `turn.completed`.
 */
export type CodexHookTranscriptReader = {
    /**
     * Process a single raw hook in hook order, returning any newly completed
     * assistant-message events. `SessionStart` only records/resets the transcript
     * path; every other hook reads newly appended rollout bytes; `Stop`
     * additionally classifies the held (last) message as the terminal `final:true`.
     */
    handleHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[];
    reset: () => void;
};
export type CodexHookTranscriptReaderOptions = {
    now: () => Date;
    invocationId: string;
    getCurrentTurnId: () => string | undefined;
};
export declare function createCodexHookTranscriptReader(options: CodexHookTranscriptReaderOptions): CodexHookTranscriptReader;
//# sourceMappingURL=hook-transcript.d.ts.map