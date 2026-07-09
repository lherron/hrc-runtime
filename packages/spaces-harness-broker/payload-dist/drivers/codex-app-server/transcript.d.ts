import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol';
export interface TranscriptStyle {
    bold: (value: string) => string;
    dim: (value: string) => string;
    accent: (value: string) => string;
    done: (value: string) => string;
    error: (value: string) => string;
    warn: (value: string) => string;
    rule: (value: string) => string;
}
/**
 * Build the ANSI palette. Each segment is wrapped-and-reset independently; we
 * never wrap an already-wrapped string, so a trailing reset can't truncate an
 * outer colour. Concatenate styled segments instead of nesting them.
 */
export declare function createTranscriptStyle(color: boolean): TranscriptStyle;
export interface CodexTranscriptModelOptions {
    invocationId: string;
    emit: (line: string) => void;
    color?: boolean | undefined;
    width?: number | undefined;
}
export interface CodexTranscriptModel {
    /** Fold one durable broker event into the transcript, emitting styled lines. */
    apply: (event: InvocationEventEnvelope) => void;
    /** Surface a durable-read failure visibly (never silently dropped). */
    readFailure: (text: string) => void;
}
/**
 * Stateful transcript model. Coalesces assistant `*.delta` streams into the
 * finalized message, pairs `tool.call.started`/`completed` into a grouped block,
 * tracks per-turn usage + elapsed for the footer, and styles every other event
 * type with the shared palette.
 */
export declare function createCodexTranscriptModel(options: CodexTranscriptModelOptions): CodexTranscriptModel;
//# sourceMappingURL=transcript.d.ts.map