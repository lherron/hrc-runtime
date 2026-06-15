/**
 * Shared JSON leaf utilities for the broker module.
 *
 * `isRecord` was previously defined byte-identically in three places
 * (`runtime-hosting.ts`, `runtime-state.ts`, `event-mapper/helpers.ts`); this is
 * the single canonical definition they now import. Pure, dependency-free, no
 * behavior change — the predicate is unchanged.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
