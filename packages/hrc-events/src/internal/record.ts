/**
 * Internal helpers shared across normalizers. Not exported from the package
 * barrel — keep the public surface unchanged.
 */

/**
 * Coerce an arbitrary value to a plain record, allowing arrays to pass through
 * as records. This is the deliberate "arrays-allowed" variant used for raw
 * tool-input payloads (some tools legitimately send array-shaped `tool_input`).
 * For the stricter object-only coercion that rejects arrays, use `asRecord`.
 */
export function asToolInputRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  return value as Record<string, unknown>
}

/**
 * Coerce a value to a plain object-record, rejecting arrays. This is the
 * stricter object-only variant (distinct from `asToolInputRecord`, which
 * deliberately lets arrays through).
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Return the first string-valued field among `keys`, or undefined. */
export function getString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/** Return the first boolean-valued field among `keys`, or undefined. */
export function getBoolean(
  record: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

/**
 * Like `getBoolean`, but also coerces the stringified booleans `'true'` and
 * `'false'`. OTEL attribute values arrive stringly-typed, so this string
 * coercion is load-bearing for the OTEL normalizer.
 */
export function getBooleanCoerced(
  record: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
  }
  return undefined
}

/** Return the first array-rejecting object-record among `keys`, or `{}`. */
export function getRecord(
  record: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  for (const key of keys) {
    const value = asRecord(record[key])
    if (value) return value
  }
  return {}
}

/** Truncate `s` to `max` characters, appending a single-character ellipsis. */
export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
