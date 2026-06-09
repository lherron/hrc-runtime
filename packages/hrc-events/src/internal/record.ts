/**
 * Internal helpers shared across normalizers. Not exported from the package
 * barrel — keep the public surface unchanged.
 */

/** Coerce an arbitrary value to a plain record, or undefined if not object-shaped. */
export function asToolInputRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  return value as Record<string, unknown>
}
