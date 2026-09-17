/**
 * T-08564 Phase A red: invalid producer declarations have their own stable HRC
 * error code and 422 projection. Runtime casts keep this test collectible before
 * the additive constant exists; green requires the public hrc-core surface.
 */
import { describe, expect, test } from 'bun:test'

import { HrcErrorCode, httpStatusForErrorCode } from '../index.js'

describe('T-08564 declaration-invalid error contract', () => {
  test('exports declaration_invalid and maps it to HTTP 422', () => {
    const codes = HrcErrorCode as unknown as Record<string, string | undefined>

    expect(codes['DECLARATION_INVALID']).toBe('declaration_invalid')
    expect(httpStatusForErrorCode('declaration_invalid' as never)).toBe(422)
  })
})
