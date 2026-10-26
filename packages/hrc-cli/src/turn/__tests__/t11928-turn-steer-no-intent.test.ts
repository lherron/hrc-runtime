/**
 * T-11928 — `hrc turn` to a session that never applied an intent. The mail
 * injector mints sessions with persistIntent:false, so a seat whose first birth
 * failed has nothing for the steer door to replay and both servers refuse it
 * `missing_runtime_intent`. The command already holds the resolved intent: it
 * falls through to the handoff door, which persists that intent and births.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import {
  HrcDomainError,
  HrcErrorCode,
  type SemanticTurnHandoffRequest,
  type SteerSubmissionRequest,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { installOldEngineDaemon } from '../../__tests__/old-engine-daemon.js'
import { createTurnClient, runTurnCommand } from './turn-test-harness.js'

const oldEngineDaemon = installOldEngineDaemon()
afterAll(() => oldEngineDaemon.stop())

function refusingSteer(code: HrcErrorCode, steerCalls: SteerSubmissionRequest[]) {
  const handoffCalls: SemanticTurnHandoffRequest[] = []
  const client = {
    ...createTurnClient({ sessionFound: true, handoffCalls }),
    async steer(request: SteerSubmissionRequest) {
      steerCalls.push(request)
      throw new HrcDomainError(
        code,
        'runtimeIntent is required when the session has no prior intent'
      )
    },
  } as HrcClient
  return { client, handoffCalls }
}

describe('hrc turn — steer to a session with no applied intent (T-11928)', () => {
  it('falls through to the handoff door carrying the resolved intent', async () => {
    const steerCalls: SteerSubmissionRequest[] = []
    const { client, handoffCalls } = refusingSteer(HrcErrorCode.MISSING_RUNTIME_INTENT, steerCalls)

    const result = await runTurnCommand(client, { format: 'ndjson' }, ['cody@agent-spaces', 'wake'])

    expect(result.exitCode).toBe(0)
    expect(steerCalls).toHaveLength(1)
    expect(handoffCalls).toHaveLength(1)
    expect(handoffCalls[0]?.body).toBe('wake')
    expect(handoffCalls[0]?.createIfMissing).toBe(true)
    expect(handoffCalls[0]?.runtimeIntent?.placement).toBeDefined()
    expect(result.stderr).toContain('no applied runtime intent')
  })

  it('--wait final falls through the same way', async () => {
    const steerCalls: SteerSubmissionRequest[] = []
    const { client, handoffCalls } = refusingSteer(HrcErrorCode.MISSING_RUNTIME_INTENT, steerCalls)

    const result = await runTurnCommand(client, { wait: 'final' }, ['cody@agent-spaces', 'wake'])

    expect(steerCalls[0]?.wait).toBe(true)
    expect(handoffCalls).toHaveLength(1)
    expect(handoffCalls[0]?.runtimeIntent?.placement).toBeDefined()
    expect(result.stderr).toContain('no applied runtime intent')
  })

  it('any other steer refusal still fails the command — the control', async () => {
    const steerCalls: SteerSubmissionRequest[] = []
    const { client, handoffCalls } = refusingSteer(HrcErrorCode.RUNTIME_UNAVAILABLE, steerCalls)

    const result = await runTurnCommand(client, { format: 'ndjson' }, ['cody@agent-spaces', 'wake'])

    expect(result.exitCode).not.toBe(0)
    expect(handoffCalls).toHaveLength(0)
  })
})
