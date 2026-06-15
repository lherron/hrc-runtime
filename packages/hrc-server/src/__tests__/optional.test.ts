/**
 * Regression guard for the `optional()` helper (T-04743).
 *
 * The whole point of the helper is the exact-field-set invariant: a key must be
 * ABSENT (not present-with-undefined) when its value is `undefined`. Several
 * call sites feed request/event payloads hashed upstream (jsonEqual /
 * recomputeStartRequestHash), where a `{ key: undefined }` regression would
 * silently diverge a hash. These tests assert byte-identity against the inline
 * `...(v !== undefined ? { k: v } : {})` idiom the helper replaced.
 */
import { describe, expect, it } from 'bun:test'

import { optional } from '../agent-spaces-adapter/optional'

describe('optional()', () => {
  it('omits the key entirely when the value is undefined', () => {
    const result = optional('semantics', undefined)
    expect(result).toEqual({})
    expect('semantics' in result).toBe(false)
    expect(Object.keys(result)).toEqual([])
  })

  it('includes the key with its value when defined', () => {
    expect(optional('semantics', 'append_context')).toEqual({ semantics: 'append_context' })
  })

  it('preserves falsy-but-defined values (empty string, 0, false, null)', () => {
    expect(optional('prompt', '')).toEqual({ prompt: '' })
    expect(optional('n', 0)).toEqual({ n: 0 })
    expect(optional('flag', false)).toEqual({ flag: false })
    expect(optional('x', null)).toEqual({ x: null })
  })

  it('is byte-identical to the inline idiom for defined and undefined inputs', () => {
    const inline = <V>(k: string, v: V | undefined) => (v !== undefined ? { [k]: v } : {})
    for (const value of [undefined, 'v', '', 0, false, null, { a: 1 }] as const) {
      const viaHelper = JSON.stringify({ base: 1, ...optional('k', value) })
      const viaInline = JSON.stringify({ base: 1, ...inline('k', value) })
      expect(viaHelper).toBe(viaInline)
    }
  })
})
