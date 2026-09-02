import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'

import { type HrcServer, createHrcServer } from '../index.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { parseSubmissionRequest } from '../server-parsers.js'
import { projectSubmissionResponse } from '../turn-dispatch-handlers.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const runtimeIntent: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: {
    provider: 'openai',
    id: 'codex',
    interactive: false,
  },
  execution: {
    preferredMode: 'headless',
    allowInteractiveSurfaceReuse: false,
  },
}

type CapturedDispatch = {
  hostSessionId: string
  intent: HrcRuntimeIntent
  prompt: string
  establishedBrokerInvocationId?: string | undefined
}

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let internal: HrcServerInstanceForHandlers
let hostSessionId: string
let captures: CapturedDispatch[]

beforeEach(async () => {
  fixture = await createHrcTestFixture('submission-session-surface-')
  server = await createHrcServer(fixture.serverOpts())
  internal = server as unknown as HrcServerInstanceForHandlers
  hostSessionId = (await fixture.resolveSession('submission-session-surface')).hostSessionId
  captures = []
  internal.dispatchTurnForSession = async (session, intent, prompt, options) => {
    captures.push({
      hostSessionId: session.hostSessionId,
      intent,
      prompt,
      ...(options.establishedBrokerInvocationId !== undefined
        ? { establishedBrokerInvocationId: options.establishedBrokerInvocationId }
        : {}),
    })
    const rejected = options.establishedBrokerInvocationId === 'inv-forged'
    return Response.json({
      submissionId: rejected ? 'sub-rejected' : 'sub-admitted',
      admission: rejected ? 'rejected' : 'admitted',
      ...(rejected ? { reason: 'interactive-surface-reuse-refused' } : {}),
      runId: 'run-fixed',
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: 'rt-fixed',
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
      startIdentity: { kind: 'broker', invocationId: 'inv-fixed' },
      observation: {
        lifecycle: {
          selector: {
            runId: 'run-fixed',
            runtimeId: 'rt-fixed',
            generation: session.generation,
          },
          fromSeq: 41,
        },
        broker: {
          selector: {
            invocationId: 'inv-fixed',
            runId: 'run-fixed',
            runtimeId: 'rt-fixed',
            generation: session.generation,
          },
          afterSeq: 73,
        },
      },
    })
  }
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

function doorBody(establishedBrokerInvocationId = 'inv-established') {
  return {
    target: hostSessionId,
    body: 'ship it',
    origin: { principalRef: 'agent:cody' },
    runtimeIntent,
    establishedBrokerInvocationId,
    turnPolicy: 'guarded' as const,
    wait: false,
  }
}

function turnsBody(establishedBrokerInvocationId = 'inv-established') {
  return {
    hostSessionId,
    prompt: 'ship it',
    runtimeIntent,
    establishedBrokerInvocationId,
    origin: { actor: 'agent:cody', kind: 'agent' as const },
  }
}

describe('T-07880 invoke-door session-bound dispatch surface', () => {
  it('accepts runtimeIntent and establishedBrokerInvocationId on invoke, enqueue and preempt but rejects them on steer', () => {
    for (const door of ['invoke', 'enqueue', 'preempt'] as const) {
      expect(parseSubmissionRequest(doorBody(), door)).toMatchObject({
        target: hostSessionId,
        runtimeIntent: { harness: { provider: 'openai' } },
        establishedBrokerInvocationId: 'inv-established',
      })
    }
    expect(() => parseSubmissionRequest(doorBody(), 'steer')).toThrow(
      'unknown field "runtimeIntent"'
    )
  })

  it('dispatches an invoke directly to a hostSessionId and applies first-dispatch runtimeIntent plus ownership proof', async () => {
    const response = await fixture.postJson('/v1/submissions/invoke', doorBody())
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(202)
    expect(captures).toHaveLength(1)
    expect(captures[0]).toMatchObject({
      hostSessionId,
      prompt: 'ship it',
      establishedBrokerInvocationId: 'inv-established',
      intent: {
        harness: { provider: 'openai' },
        placement: { correlation: { hostSessionId } },
      },
    })
    expect(body).toMatchObject({
      admission: 'admitted',
      submissionId: 'sub-admitted',
      runId: 'run-fixed',
      runtimeId: 'rt-fixed',
      hostSessionId,
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      startIdentity: { kind: 'broker', invocationId: 'inv-fixed' },
      observation: {
        lifecycle: { selector: { runId: 'run-fixed', runtimeId: 'rt-fixed' }, fromSeq: 41 },
        broker: { selector: { invocationId: 'inv-fixed' }, afterSeq: 73 },
      },
    })
  })

  it('typed admission rejection omits every run and observation cursor', async () => {
    const response = await fixture.postJson('/v1/submissions/invoke', doorBody('inv-forged'))
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toEqual({
      submissionId: 'sub-rejected',
      admission: 'rejected',
      reason: 'interactive-surface-reuse-refused',
      disposition: {
        type: 'rejected',
        reason: 'interactive-surface-reuse-refused',
      },
    })
    for (const field of [
      'runId',
      'runtimeId',
      'hostSessionId',
      'generation',
      'transport',
      'status',
      'startIdentity',
      'observation',
    ]) {
      expect(body).not.toHaveProperty(field)
    }
  })

  it('typed submission expiry omits every run and observation cursor', () => {
    const body = projectSubmissionResponse(
      {
        submissionId: 'sub-expired',
        admission: 'admitted',
        runId: 'run-fixed',
        hostSessionId,
        generation: 1,
        runtimeId: 'rt-fixed',
        transport: 'headless',
        supportsInFlightInput: false,
        status: 'started',
        stage: 'turn_started',
        replayed: false,
        startIdentity: { kind: 'broker', invocationId: 'inv-fixed' },
        observation: {
          lifecycle: {
            selector: { runId: 'run-fixed', runtimeId: 'rt-fixed', generation: 1 },
            fromSeq: 41,
          },
        },
      },
      { disposition: { type: 'expired' } },
      true
    )

    expect(body).toEqual({
      submissionId: 'sub-expired',
      admission: 'admitted',
      disposition: { type: 'expired' },
    })
  })

  it('/v1/turns is a deep-equal invoke-door response alias for the same session-bound dispatch', async () => {
    const invoke = await fixture.postJson('/v1/submissions/invoke', doorBody())
    const turns = await fixture.postJson('/v1/turns', turnsBody())

    expect(turns.status).toBe(invoke.status)
    expect(await turns.json()).toEqual(await invoke.json())
  })

  it('forged ownership proof has typed refusal parity through /v1/turns and the invoke door', async () => {
    const invoke = await fixture.postJson('/v1/submissions/invoke', doorBody('inv-forged'))
    const turns = await fixture.postJson('/v1/turns', turnsBody('inv-forged'))

    expect(await turns.json()).toEqual(await invoke.json())
  })
})
