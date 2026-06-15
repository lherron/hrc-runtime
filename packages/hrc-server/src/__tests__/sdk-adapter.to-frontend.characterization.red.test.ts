/**
 * Characterization + RED tests for toFrontend() in sdk-adapter.ts (T-04744).
 *
 * BACKGROUND
 * ----------
 * toFrontend() maps an HrcProvider → the SDK harness frontend string that
 * agent-spaces expects ('agent-sdk' | 'pi-sdk'). Today the function has a
 * silent fallback: when the resolved frontend is neither of the two known
 * values, it returns 'agent-sdk' instead of failing. T-04744 replaces that
 * silent coercion with a typed HrcUnprocessableEntityError(PROVIDER_MISMATCH).
 *
 * WHAT IS IN THIS FILE
 * --------------------
 * 1. CHARACTERIZATION (green now): pins every currently-valid provider →
 *    frontend mapping so the impl can never silently change a known mapping.
 *
 * 2. RED — T-04744 (FAILING NOW, will pass after impl): asserts that an
 *    unknown provider throws HrcUnprocessableEntityError with code
 *    PROVIDER_MISMATCH.  Today it silently returns 'agent-sdk', so this test
 *    FAILS — that is the intended red.
 */
import { describe, expect, it } from 'bun:test'

import { HrcErrorCode, HrcUnprocessableEntityError } from 'hrc-core'

import { toFrontend } from '../agent-spaces-adapter/sdk-adapter'

// ---------------------------------------------------------------------------
// 1. CHARACTERIZATION — valid provider → frontend mappings (green now)
// ---------------------------------------------------------------------------

describe('toFrontend characterization — T-04744', () => {
  it("maps 'anthropic' → 'agent-sdk'", () => {
    expect(toFrontend('anthropic')).toBe('agent-sdk')
  })

  it("maps 'openai' → 'pi-sdk'", () => {
    expect(toFrontend('openai')).toBe('pi-sdk')
  })
})

// ---------------------------------------------------------------------------
// 2. RED — T-04744 (FAILING NOW, will pass after impl)
//
// Today: toFrontend('bad-provider' as HrcProvider) silently returns
//        'agent-sdk' → test FAILS (no throw).
// After impl: throws HrcUnprocessableEntityError(PROVIDER_MISMATCH)
//             → test PASSES (green).
// ---------------------------------------------------------------------------

describe('toFrontend RED — unknown provider must throw (T-04744)', () => {
  it('throws HrcUnprocessableEntityError with PROVIDER_MISMATCH for an unknown provider [RED — T-04744]', () => {
    // Cast is deliberate: simulates a runtime value that TypeScript can't
    // prevent (e.g. deserialized from an older wire payload or a future
    // provider not yet in the catalog).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => toFrontend('bad-provider' as any)).toThrow(HrcUnprocessableEntityError)

    // Also assert the typed error code so the impl can't throw the wrong
    // domain error and still go green.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let caught: unknown
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toFrontend('bad-provider' as any)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HrcUnprocessableEntityError)
    expect((caught as HrcUnprocessableEntityError).code).toBe(HrcErrorCode.PROVIDER_MISMATCH)
  })
})
