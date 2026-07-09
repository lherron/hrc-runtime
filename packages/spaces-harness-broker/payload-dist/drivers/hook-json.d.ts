/**
 * Tiny JSON-poke helpers shared by the tmux/codex hook normalizers and
 * transcript readers. These were previously re-declared with byte-identical
 * bodies across both drivers' `hook-events.ts`, `hook-transcript.ts`, and
 * `driver.ts` modules; lifted here to a single internal module to prevent drift.
 *
 * NOTE: `codex-app-server/event-map.ts` keeps its own `asRecord` because that
 * variant intentionally treats arrays as records (no `Array.isArray` guard) and
 * is therefore NOT equivalent to the one exported here.
 */
/** Coerce a value to a plain record, mapping non-objects/arrays to `{}`. */
export declare function asRecord(value: unknown): Record<string, unknown>;
/** Read a string-typed field off a record, else `undefined`. */
export declare function getString(obj: Record<string, unknown>, key: string): string | undefined;
/** Read an integer-typed field off a record, else `undefined`. */
export declare function getNumber(obj: Record<string, unknown>, key: string): number | undefined;
/**
 * Normalize a hook record to its inner payload: hooks may arrive flat (with a
 * top-level `hook_event_name`) or wrapped under a `hookEvent` object.
 */
export declare function unwrapHookPayload(hook: Record<string, unknown>): Record<string, unknown>;
//# sourceMappingURL=hook-json.d.ts.map