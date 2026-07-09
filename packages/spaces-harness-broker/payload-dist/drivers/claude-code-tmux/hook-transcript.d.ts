import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol';
/**
 * Hook-driven Claude Code session-transcript reader (T-02027).
 *
 * `UserPromptSubmit` fires ONLY for prompts submitted while the agent is idle.
 * A prompt typed while the agent is MID-TURN (actively running tools) is queued
 * /steered into the active turn by Claude and fires NO `UserPromptSubmit` — so
 * the broker never sees it and no `turn.user_prompt`/viewer row appears.
 *
 * Verified against a live e2e transcript: the steered prompt's ONLY record is a
 * `queue-operation`/`enqueue` line carrying the typed text in `content`:
 *   {"type":"queue-operation","operation":"enqueue","content":"<typed text>"}
 * (a `queue-operation`/`remove` follows at dequeue). Idle prompts instead appear
 * as `type:"user"` entries AND fire `UserPromptSubmit`; the two channels are
 * DISJOINT, so emitting `user.message` on `enqueue` does NOT double-count idle
 * prompts and needs NO dedup against `UserPromptSubmit`.
 *
 * It additionally surfaces Claude Code API-failure rows (T-05092). CC records
 * an API error as an `type:"assistant"` row with `isApiErrorMessage:true` whose
 * text lives under `message.content[].text`, plus top-level `requestId`/`error`.
 * Like the steered prompt, this NEVER arrives via a hook, so this transcript
 * reader is its only path to the broker. Each such row emits exactly one
 * non-terminal `diagnostic` (`level:'error'`, `source:'harness'`,
 * `data.code:'api_error'`) — it MUST NOT by itself mint a terminal/lifecycle
 * event (daedalus ruling, DM #9988). Because the byte-offset tailer never
 * re-reads a consumed row, no dedup is needed across hook reads and the stop()
 * drain.
 *
 * This reader mirrors the codex-cli-tmux transcript reader's synchronous,
 * hook-driven, byte-offset JSONL tailer, but is far simpler — no held-latest /
 * delta coalescing / terminal classification. The driver calls
 * {@link ClaudeHookTranscriptReader.handleHook} BEFORE `normalizeHookEnvelope`
 * and emits the returned `user.message` events first, so a mid-turn prompt lands
 * in hook order ahead of the triggering hook's normalized events. The emitted
 * `user.message` reuses the EXISTING hop-3 map (`user.message → turn.user_prompt`)
 * verbatim — no new event type, no downstream change.
 */
export type ClaudeHookTranscriptReader = {
    /**
     * Process a single raw hook in hook order, returning any newly observed
     * mid-turn user-prompt events. `SessionStart` only records/resets the
     * transcript path; every other hook reads newly appended transcript bytes and
     * emits one `user.message` per `queue-operation`/`enqueue` line.
     */
    handleHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[];
    /**
     * Read any transcript bytes appended since the last read WITHOUT a triggering
     * hook, emitting the same events `handleHook` would. The driver calls this in
     * `stop()` (before `reset()`) so a trailing API-error row that no post-error
     * hook would surface still reaches the broker. The byte-offset tailer is the
     * dedupe mechanism: rows already consumed by a prior read are not replayed.
     */
    drain: () => InvocationEventEnvelope[];
    reset: () => void;
};
export type ClaudeHookTranscriptReaderOptions = {
    now: () => Date;
    invocationId: string;
    getCurrentTurnId: () => string | undefined;
};
export declare function createClaudeHookTranscriptReader(options: ClaudeHookTranscriptReaderOptions): ClaudeHookTranscriptReader;
//# sourceMappingURL=hook-transcript.d.ts.map