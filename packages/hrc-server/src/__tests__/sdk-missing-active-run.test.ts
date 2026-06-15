/**
 * Characterization test for the missing-active-run retry classifier (T-04745).
 *
 * `deliverSdkInflightInput` retries while the upstream agent-spaces client
 * reports the run is "not yet active". Upstream throws a PLAIN `Error` with no
 * typed code/subclass (see agent-spaces packages/agent-spaces/src/client.ts
 * queueInFlightInput @ ~566 and interruptInFlightTurn @ ~606), so the only
 * available signal is a substring of the human-readable message. This test pins
 * the EXACT upstream wording so the retry contract goes red if it drifts.
 */
import { describe, expect, it } from 'bun:test'

import { isMissingActiveRunError } from '../agent-spaces-adapter/sdk-adapter'

// Mirror of the literal agent-spaces throws (client.ts):
//   throw new Error(`No active in-flight run for hostSessionId ${hostSessionId}`)
const upstreamMissingActiveRunError = (hostSessionId: string): Error =>
  new Error(`No active in-flight run for hostSessionId ${hostSessionId}`)

describe('isMissingActiveRunError', () => {
  it('classifies the exact upstream agent-spaces wording as retry-eligible', () => {
    expect(isMissingActiveRunError(upstreamMissingActiveRunError('hsid-active-retry'))).toBe(true)
  })

  it('does NOT classify the adjacent run-mismatch / completed errors as retry-eligible', () => {
    // These are distinct upstream conditions that must propagate, not retry.
    expect(
      isMissingActiveRunError(
        new Error('Active in-flight run mismatch for hostSessionId hsid-x: expected r1, got r2')
      )
    ).toBe(false)
    expect(isMissingActiveRunError(new Error('In-flight run r1 is already completed'))).toBe(false)
  })

  it('does not classify unrelated errors or non-Error throwables', () => {
    expect(isMissingActiveRunError(new Error('some other failure'))).toBe(false)
    expect(isMissingActiveRunError('No active in-flight run')).toBe(false)
    expect(isMissingActiveRunError(undefined)).toBe(false)
    expect(isMissingActiveRunError({ message: 'No active in-flight run' })).toBe(false)
  })
})
