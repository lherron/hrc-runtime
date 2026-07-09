/**
 * Shared byte-offset JSONL tailer for the hook-driven transcript readers
 * (claude-code-tmux and codex-cli-tmux). Both readers tail an append-only
 * transcript file synchronously from hook processing: they remember a byte
 * offset, read newly appended bytes, buffer a trailing partial line, and emit
 * complete `\n`-terminated lines IN ORDER.
 *
 * Only the file-tailing mechanics are shared here. The per-line state machine
 * (what each line MEANS, and what events it produces) stays divergent and lives
 * in each reader, passed in as the `onLine` callback.
 */
export interface JsonlByteOffsetTailer {
    /** The active file path, or undefined when none is set. */
    getActivePath(): string | undefined;
    /**
     * Point the tailer at a new path and rewind offset/partial. No-op returning
     * `false` when the path is unchanged; returns `true` when it actually changed
     * (the caller resets its own per-line state on a true result).
     */
    retarget(path: string): boolean;
    /** Forget the active path and rewind offset/partial. */
    clear(): void;
    /**
     * Read newly appended bytes from the active file and invoke `onLine` once per
     * complete line, in order. Tolerates a missing/non-file path and truncation
     * (rewinds to 0 when the file shrinks below the offset); swallows IO errors.
     */
    readNewLines(onLine: (line: string) => void): void;
}
export declare function createJsonlByteOffsetTailer(): JsonlByteOffsetTailer;
//# sourceMappingURL=jsonl-byte-tailer.d.ts.map