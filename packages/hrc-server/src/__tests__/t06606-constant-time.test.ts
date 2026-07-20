/**
 * T-06606 addendum — shared constant-time comparison + PeerToken.matches.
 *
 * Constant-time compare is easy to get subtly wrong, and it sits on an
 * authentication path, so the edge cases are pinned rather than assumed.
 */

import { describe, expect, test } from 'bun:test'

import { constantTimeEqual } from '../constant-time.js'
import { PeerToken, REDACTED_PEER_TOKEN } from '../federation/peer-token.js'

describe('constantTimeEqual', () => {
  test('equal strings match', () => {
    expect(constantTimeEqual('secret', 'secret')).toBe(true)
    expect(constantTimeEqual('', '')).toBe(true)
    expect(constantTimeEqual('a'.repeat(4096), 'a'.repeat(4096))).toBe(true)
  })

  test('same-length mismatch returns false', () => {
    expect(constantTimeEqual('secret', 'secreT')).toBe(false)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'xyz')).toBe(false)
  })

  test('different-length mismatch returns false', () => {
    expect(constantTimeEqual('secret', 'secretx')).toBe(false)
    expect(constantTimeEqual('secretx', 'secret')).toBe(false)
    expect(constantTimeEqual('', 'secret')).toBe(false)
    expect(constantTimeEqual('secret', '')).toBe(false)
  })

  test('multi-byte input with equal UTF-16 length but unequal byte length', () => {
    // Regression: the pre-extraction implementation compared `.length` (UTF-16
    // code units) and only then converted to Buffers, so these pairs reached
    // timingSafeEqual with mismatched byte lengths and threw a RangeError.
    // On an auth path that turns "wrong credential" into a crash.
    expect(constantTimeEqual('é', 'a')).toBe(false)
    expect(constantTimeEqual('a', 'é')).toBe(false)
    expect(constantTimeEqual('abc', 'ébc')).toBe(false)
    expect(constantTimeEqual('日本', 'ab')).toBe(false)
  })

  test('multi-byte input compares correctly when genuinely equal', () => {
    expect(constantTimeEqual('token-é-日本', 'token-é-日本')).toBe(true)
    expect(constantTimeEqual('token-é', 'token-e')).toBe(false)
  })

  test('never throws for any input pairing', () => {
    const samples = ['', 'a', 'abc', 'é', '日本語', '\0', 'a\0b', 'x'.repeat(100)]
    for (const a of samples) {
      for (const b of samples) {
        expect(() => constantTimeEqual(a, b)).not.toThrow()
      }
    }
  })

  test('embedded NUL bytes are compared, not treated as terminators', () => {
    expect(constantTimeEqual('a\0b', 'a\0b')).toBe(true)
    expect(constantTimeEqual('a\0b', 'a\0c')).toBe(false)
    // Would collide if a mismatch were zero-padded into equality.
    expect(constantTimeEqual('a', 'a\0')).toBe(false)
  })
})

describe('PeerToken.matches', () => {
  const SECRET = 'peer-bearer-token-value'

  test('matches the correct secret and rejects others', () => {
    const token = new PeerToken(SECRET)
    expect(token.matches(SECRET)).toBe(true)
    expect(token.matches('peer-bearer-token-valuE')).toBe(false)
    expect(token.matches('wrong')).toBe(false)
    expect(token.matches('')).toBe(false)
    expect(token.matches(`${SECRET}x`)).toBe(false)
  })

  test('comparison adds no egress path — no reveal, no leak on failure', () => {
    const token = new PeerToken(SECRET)
    // A failed comparison must not surface the secret through any path a
    // caller might log.
    expect(token.matches('guess')).toBe(false)
    expect(`${token}`).toBe(REDACTED_PEER_TOKEN)
    expect(JSON.stringify(token)).not.toContain(SECRET)

    const error = new Error(`peer auth failed for token ${token}`)
    expect(error.message).not.toContain(SECRET)
  })

  test('does not throw on multi-byte candidates', () => {
    const token = new PeerToken('ascii-token')
    expect(() => token.matches('é'.repeat(11))).not.toThrow()
    expect(token.matches('é'.repeat(11))).toBe(false)
  })
})
