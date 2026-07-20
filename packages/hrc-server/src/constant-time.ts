/**
 * Constant-time secret comparison.
 *
 * One implementation for the whole server: duplicated crypto primitives are how
 * one copy gets fixed and the other quietly does not. Used by the OTEL ingest
 * auth check and by `PeerToken.matches` (federation §6).
 */

import { timingSafeEqual } from 'node:crypto'

/**
 * Compares two secrets without leaking their contents — or their lengths —
 * through timing.
 *
 * Length handling is the subtle part. `timingSafeEqual` throws unless both
 * buffers have the same byte length, and a naive early `return false` on a
 * length mismatch would make "wrong length" measurably faster than "right
 * length, wrong bytes". So a mismatch still runs a full compare over
 * zero-padded buffers of equal size and discards the result.
 *
 * Lengths are compared in UTF-8 *bytes*, not UTF-16 code units: `'é'` and `'a'`
 * are both `.length === 1` but occupy 2 and 1 bytes, which would reach
 * `timingSafeEqual` with mismatched buffers and throw a RangeError. On an
 * authentication path that turns a wrong-credential answer into a crash, so the
 * conversion happens before the length check rather than after.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')

  if (bufA.length !== bufB.length) {
    const size = Math.max(bufA.length, bufB.length, 1)
    const paddedA = Buffer.alloc(size)
    const paddedB = Buffer.alloc(size)
    bufA.copy(paddedA)
    bufB.copy(paddedB)
    timingSafeEqual(paddedA, paddedB)
    return false
  }

  if (bufA.length === 0) return true
  return timingSafeEqual(bufA, bufB)
}
