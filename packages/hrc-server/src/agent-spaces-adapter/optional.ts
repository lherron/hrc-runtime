/**
 * Tiny helper for the `...(value !== undefined ? { key: value } : {})` idiom.
 *
 * Returns a single-key object when `value` is defined, or an EMPTY object when
 * it is `undefined`. The exact-field-set invariant is load-bearing: several
 * call sites feed request/event payloads that are hashed/projected upstream
 * (jsonEqual / recomputeStartRequestHash), where an accidental `{ key: undefined }`
 * (key present with an undefined value) would silently diverge a hash.
 *
 * This MUST reproduce "key ABSENT when value is `undefined`" (NOT "key present
 * = undefined"). It gates strictly on `=== undefined`, identical to the inline
 * idiom it replaces — so `JSON.stringify` of the built object is byte-identical
 * for both defined and undefined inputs.
 *
 * Note: this intentionally does NOT replace the truthiness idiom
 * `...(value ? { key: value } : {})`, which has a different predicate (it also
 * drops null/''/0/false). Only the strict `!== undefined` sites use this.
 */
export function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}
