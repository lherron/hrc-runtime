/**
 * T-08536 — the steer door fails open.
 *
 * A seat whose driver POSITIVELY advertised admission classes without `steer`
 * gets the body through enqueue, and the response and the ledger say so. The
 * state this suite exists to catch the detector firing in is the steer-capable
 * seat: it must reach the broker as a steer with no downgrade fields and no
 * ledger row. Silence (an undeclared class list) is not refusal either.
 *
 * Run with: TMPDIR=/tmp bun test packages/hrc-server/src/__tests__/t08536-steer-door-fail-open.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcSubmissionResponse } from 'hrc-core'

import { handleSubmission, submissionDoorReport } from '../turn-dispatch-handlers'

import {
  GENERATION,
  HOST_SESSION_ID,
  INVOCATION_ID,
  LANE_REF,
  RUNTIME_ID,
  SCOPE_REF,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'
import type { SeededFixture } from './broker-event-mapper-fixtures'

/** Driver declarations verbatim (agent-spaces drivers). */
const CLASSES = {
  claudeCodeTmux: ['steer', 'queue', 'exclusive', 'preempt'],
  agentHarnessTmux: ['queue'],
} as const

const caps = (classes: readonly string[]) => JSON.stringify({ admission: { classes } })

type DispatchCall = { prompt: string; options: Record<string, unknown> }

describe('T-08536 steer door fail-open', () => {
  let fixture: SeededFixture
  let calls: DispatchCall[]

  beforeEach(async () => {
    fixture = await makeSeededFixture()
    calls = []
    fixture.db.sessions.updateIntent(
      HOST_SESSION_ID,
      { placement: { agentRoot: '/tmp/agent' } } as unknown as HrcRuntimeIntent,
      ts(5)
    )
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  const seat = (classes: readonly string[] | undefined) => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      activeInvocationId: String(INVOCATION_ID),
      status: 'ready',
      updatedAt: ts(10),
    })
    if (classes !== undefined) {
      fixture.db.brokerInvocations.update(INVOCATION_ID, {
        capabilitiesJson: caps(classes),
        updatedAt: ts(10),
      })
    }
  }

  const server = () =>
    ({
      db: fixture.db,
      dispatchTurnForSession: async (
        _session: unknown,
        _intent: unknown,
        prompt: string,
        options: Record<string, unknown>
      ) => {
        calls.push({ prompt, options })
        return Response.json({
          runId: options['runId'],
          hostSessionId: HOST_SESSION_ID,
          generation: GENERATION,
          runtimeId: RUNTIME_ID,
          transport: 'tmux',
          submissionId: 'sub-1',
          admission: 'admitted',
          observation: {
            lifecycle: { selector: { runId: options['runId'] }, fromSeq: 1 },
            broker: {
              selector: {
                invocationId: String(INVOCATION_ID),
                runId: options['runId'],
                runtimeId: RUNTIME_ID,
                generation: GENERATION,
              },
              afterSeq: 0,
            },
          },
        })
      },
    }) as unknown as ThisParameterType<typeof handleSubmission>

  const steer = async () => {
    const request = new Request('http://hrc/v1/submissions/steer', {
      method: 'POST',
      body: JSON.stringify({
        target: `${SCOPE_REF}/lane:${LANE_REF}`,
        body: 'hello now',
        origin: { principalRef: 'human:lance', envelopeId: 'EN-1' },
      }),
    })
    const response = await handleSubmission.call(server(), request, 'steer')
    return (await response.json()) as HrcSubmissionResponse
  }

  const downgradeRows = () =>
    fixture.db.hrcEvents
      .listByRun(calls[0]?.options['runId'] as string)
      .filter((event) => event.eventKind === 'submission.door_downgraded')

  it('submits through enqueue when the driver declared classes without steer', async () => {
    seat(CLASSES.agentHarnessTmux)

    const body = await steer()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toBe('hello now')
    expect(calls[0]?.options['submissionDoor']).toBe('enqueue')
    expect(calls[0]?.options['submissionOrigin']).toEqual({
      principalRef: 'human:lance',
      envelopeId: 'EN-1',
    })
    expect(body.effectiveDoor).toBe('enqueue')
    expect(body.requestedDoor).toBe('steer')
    expect(body.downgradeReason).toBe('steer_not_supported')

    const rows = downgradeRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.category).toBe('input')
    expect(rows[0]?.runtimeId).toBe(RUNTIME_ID)
    expect(rows[0]?.payload).toEqual({
      runtimeId: RUNTIME_ID,
      invocationId: String(INVOCATION_ID),
      submissionId: 'sub-1',
      requestedDoor: 'steer',
      effectiveDoor: 'enqueue',
      reason: 'steer_not_supported',
      envelopeId: 'EN-1',
    })
  })

  it('keeps the steer for a steer-capable driver — the control', async () => {
    seat(CLASSES.claudeCodeTmux)

    const body = await steer()

    expect(calls[0]?.options['submissionDoor']).toBe('steer')
    expect(body.effectiveDoor).toBe('steer')
    expect('requestedDoor' in body).toBe(false)
    expect('downgradeReason' in body).toBe(false)
    expect(downgradeRows()).toHaveLength(0)
  })

  it('keeps the steer when the invocation never declared its classes', async () => {
    seat(undefined)

    const body = await steer()

    expect(calls[0]?.options['submissionDoor']).toBe('steer')
    expect(body.effectiveDoor).toBe('steer')
    expect(downgradeRows()).toHaveLength(0)
  })

  it('keeps the steer on a cold seat (no active invocation): the launch turn carries it', () => {
    const session = fixture.db.sessions.getByHostSessionId(HOST_SESSION_ID)
    if (!session) throw new Error('session missing')
    expect(submissionDoorReport(server(), session, 'steer')).toEqual({ effectiveDoor: 'steer' })
  })

  it('never downgrades a door other than steer', () => {
    seat(CLASSES.agentHarnessTmux)
    const session = fixture.db.sessions.getByHostSessionId(HOST_SESSION_ID)
    if (!session) throw new Error('session missing')
    expect(submissionDoorReport(server(), session, 'invoke')).toEqual({ effectiveDoor: 'invoke' })
    expect(submissionDoorReport(server(), session, 'enqueue')).toEqual({
      effectiveDoor: 'enqueue',
    })
  })
})
