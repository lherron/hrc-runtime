import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { HrcErrorCode, type HrcRuntimeIntent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import {
  parseDispatchTurnRequest,
  parseOpenBrokerSessionRequest,
  parseSubmissionRequest,
} from '../parsers/runtime.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture.js'

const FORMAT2 = 'format2' as const

describe('T-08207 public execution-format ingress', () => {
  test('accepts the selector only on the six approved request shapes', () => {
    expect(
      parseOpenBrokerSessionRequest({ hostSessionId: 'hsid-open', executionFormat: FORMAT2 })
    ).toMatchObject({ executionFormat: FORMAT2 })
    expect(
      parseDispatchTurnRequest({
        hostSessionId: 'hsid-turn',
        prompt: 'submit once',
        executionFormat: FORMAT2,
      })
    ).toMatchObject({ executionFormat: FORMAT2 })

    for (const door of ['steer', 'enqueue', 'invoke', 'preempt'] as const) {
      expect(
        parseSubmissionRequest(
          {
            target: 'hsid-submission',
            body: 'submit once',
            origin: { principalRef: 'agent:cody' },
            executionFormat: FORMAT2,
          },
          door
        )
      ).toMatchObject({ executionFormat: FORMAT2 })
    }

    expect(
      parseSubmissionRequest(
        {
          target: 'agent:cody:project:hrc-runtime:task:T-08207/lane:default',
          body: 'retryable steer',
          origin: { principalRef: 'agent:cody' },
          executionFormat: FORMAT2,
          idempotencyKey: 't08207-steer-key',
        },
        'steer'
      )
    ).toMatchObject({ executionFormat: FORMAT2, idempotencyKey: 't08207-steer-key' })
  })

  test('defaults the approved wire parsers to format1 by omission', () => {
    expect(parseOpenBrokerSessionRequest({ hostSessionId: 'hsid-open' }).executionFormat).toBe(
      undefined
    )
    expect(
      parseDispatchTurnRequest({ hostSessionId: 'hsid-turn', prompt: 'legacy input' })
        .executionFormat
    ).toBeUndefined()
  })

  test('rejects a selector outside the closed format set', () => {
    expect(() =>
      parseDispatchTurnRequest({
        hostSessionId: 'hsid-turn',
        prompt: 'bad format',
        executionFormat: 'format3',
      })
    ).toThrow(/executionFormat must be "format1" or "format2"/)
  })
})

function headlessBrokerIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/t08207-agent',
      projectRoot: '/tmp/t08207-project',
      cwd: '/tmp/t08207-project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', id: 'codex-cli', interactive: false },
    execution: { preferredMode: 'headless' },
  }
}

/** The frozen compiler intent can select Codex without projecting an HRC provider. */
function compilerPrimedCodexIntent(): HrcRuntimeIntent {
  return {
    ...headlessBrokerIntent(),
    harness: { interactive: false },
    provision: { harness: 'codex' },
  }
}

function seedLiveBrokerInvocation(
  fixture: HrcServerTestFixture,
  input: {
    hostSessionId: string
    scopeRef: string
    generation: number
    executionFormat: 'format1' | 'format2'
  }
): { runtimeId: string; invocationId: string } {
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  const runtimeId = `rt-t08207-${input.executionFormat}`
  const invocationId = `inv-t08207-${input.executionFormat}`
  try {
    db.runtimes.insert({
      runtimeId,
      hostSessionId: input.hostSessionId,
      scopeRef: input.scopeRef,
      laneRef: 'default',
      generation: input.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: `op-t08207-${input.executionFormat}`,
      activeInvocationId: invocationId,
      createdAt: now,
      updatedAt: now,
    })
    db.brokerInvocations.insert({
      invocationId,
      operationId: `op-t08207-${input.executionFormat}`,
      runtimeId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      executionFormat: input.executionFormat,
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({ admission: { classes: ['steer', 'queue', 'preempt'] } }),
      specHash: 'sha256:t08207-live-format',
      startRequestHash: 'sha256:t08207-live-start',
      selectedProfileHash: 'sha256:t08207-live-profile',
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
  return { runtimeId, invocationId }
}

describe('T-08207 public turn dispatch selection', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t08207-turn-selection-')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  test.each([
    { executionFormat: undefined, expectedFormat: 'format1', hasAdmissionRun: true },
    { executionFormat: FORMAT2, expectedFormat: FORMAT2, hasAdmissionRun: false },
  ])(
    'selects $expectedFormat before dispatch and $hasAdmissionRun admits a run identity',
    async ({ executionFormat, expectedFormat, hasAdmissionRun }) => {
      const scopeRef = 'agent:cody:project:hrc-runtime:task:T-08207'
      const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
      const broker = seedLiveBrokerInvocation(fixture, {
        hostSessionId,
        scopeRef,
        generation,
        executionFormat: expectedFormat,
      })
      const captured: Array<Record<string, unknown>> = []
      Reflect.set(
        server!,
        'dispatchTurnForSession',
        async (
          _session: unknown,
          _intent: unknown,
          _prompt: string,
          options: Record<string, unknown>
        ) => {
          captured.push(options)
          return Response.json({
            hostSessionId,
            generation,
            runtimeId: broker.runtimeId,
            transport: 'headless',
            status: 'accepted',
            inputId: 'input-t08207',
            startIdentity: { kind: 'broker', invocationId: broker.invocationId },
            observation: {
              broker: {
                selector: {
                  invocationId: broker.invocationId,
                  runtimeId: broker.runtimeId,
                  generation,
                },
                afterSeq: 0,
              },
            },
          })
        }
      )

      const response = await fixture.postJson('/v1/turns', {
        hostSessionId,
        prompt: 'format selection probe',
        runtimeIntent: headlessBrokerIntent(),
        ...(executionFormat !== undefined
          ? { executionFormat, idempotencyKey: 't08207-format2-idempotency' }
          : {}),
      })

      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({ executionFormat: expectedFormat })
      expect(captured).toHaveLength(1)
      expect(captured[0]).toMatchObject({ executionFormat: expectedFormat })
      if (hasAdmissionRun) {
        expect(captured[0]?.runId).toMatch(/^run-/)
      } else {
        expect(captured[0]).not.toHaveProperty('runId')
      }
    }
  )

  test('routes a later format2 input through its exact established broker despite a compiler-only intent', async () => {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-08207'
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const broker = seedLiveBrokerInvocation(fixture, {
      hostSessionId,
      scopeRef,
      generation,
      executionFormat: FORMAT2,
    })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.sessions.updateIntent(hostSessionId, compilerPrimedCodexIntent(), fixture.now())
    } finally {
      db.close()
    }
    const routed: Array<Record<string, unknown>> = []
    Reflect.set(
      server!,
      'handleHeadlessBrokerDispatchTurn',
      async (
        _session: unknown,
        intent: { harness: Record<string, unknown> },
        _prompt: string,
        runId: string | undefined,
        options: Record<string, unknown>
      ) => {
        routed.push({ harness: intent.harness, runId, ...options })
        return Response.json({
          hostSessionId,
          generation,
          runtimeId: broker.runtimeId,
          transport: 'headless',
          status: 'accepted',
          inputId: 'input-established-format2',
          startIdentity: { kind: 'broker', invocationId: broker.invocationId },
          observation: {
            broker: {
              selector: {
                invocationId: broker.invocationId,
                runtimeId: broker.runtimeId,
                generation,
              },
              afterSeq: 0,
            },
          },
        })
      }
    )

    const response = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'later format2 input',
      executionFormat: FORMAT2,
      idempotencyKey: 't08207-established-format2',
      establishedBrokerInvocationId: broker.invocationId,
    })

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ executionFormat: FORMAT2 })
    expect(routed).toEqual([
      expect.objectContaining({
        harness: { interactive: false },
        runId: undefined,
        executionFormat: FORMAT2,
        establishedBrokerInvocationId: broker.invocationId,
      }),
    ])

    const generic = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'generic format2 input remains routed normally',
      executionFormat: FORMAT2,
      idempotencyKey: 't08207-generic-format2',
    })
    expect(generic.status).toBe(503)
    expect(await generic.json()).toMatchObject({
      error: {
        detail: {
          code: 'format2_initial_input_undeliverable',
          route: 'legacy-exec',
        },
      },
    })
  })

  test('refuses a later format2 input when its established broker identity changed', async () => {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-08207'
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    seedLiveBrokerInvocation(fixture, {
      hostSessionId,
      scopeRef,
      generation,
      executionFormat: FORMAT2,
    })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.sessions.updateIntent(hostSessionId, compilerPrimedCodexIntent(), fixture.now())
    } finally {
      db.close()
    }

    const response = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'must not join another broker invocation',
      executionFormat: FORMAT2,
      idempotencyKey: 't08207-established-mismatch',
      establishedBrokerInvocationId: 'inv-t08207-no-longer-live',
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: {
        detail: {
          reason: 'caller-surface-reuse-refusal',
          expectedInvocationId: 'inv-t08207-no-longer-live',
          actualInvocationId: 'inv-t08207-format2',
        },
      },
    })
  })
})

describe('T-08207 public submission-door selection', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t08207-submission-selection-')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  test.each(['steer', 'enqueue', 'invoke', 'preempt'] as const)(
    '%s forwards format2 and its stable idempotency identity before dispatch',
    async (door) => {
      const scopeRef = 'agent:cody:project:hrc-runtime:task:T-08207'
      const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
      const broker = seedLiveBrokerInvocation(fixture, {
        hostSessionId,
        scopeRef,
        generation,
        executionFormat: FORMAT2,
      })
      if (door === 'steer') {
        const db = openHrcDatabase(fixture.dbPath)
        try {
          db.sessions.updateIntent(hostSessionId, headlessBrokerIntent(), fixture.now())
        } finally {
          db.close()
        }
      }
      const captured: Array<Record<string, unknown>> = []
      Reflect.set(
        server!,
        'dispatchTurnForSession',
        async (
          dispatchedSession: { hostSessionId: string; generation: number },
          _intent: unknown,
          _prompt: string,
          options: Record<string, unknown>
        ) => {
          captured.push(options)
          return Response.json({
            hostSessionId: dispatchedSession.hostSessionId,
            generation: dispatchedSession.generation,
            runtimeId: broker.runtimeId,
            transport: 'headless',
            status: 'accepted',
            inputId: `input-t08207-${door}`,
            startIdentity: { kind: 'broker', invocationId: broker.invocationId },
            observation: {
              broker: {
                selector: {
                  invocationId: broker.invocationId,
                  runtimeId: broker.runtimeId,
                  generation: dispatchedSession.generation,
                },
                afterSeq: 0,
              },
            },
          })
        }
      )

      const response = await fixture.postJson(`/v1/submissions/${door}`, {
        target: door === 'steer' ? `${scopeRef}/lane:default` : hostSessionId,
        body: `format2 ${door} delivery`,
        origin: { principalRef: door === 'preempt' ? 'human:lance' : 'agent:cody' },
        ...(door === 'steer' ? {} : { runtimeIntent: headlessBrokerIntent() }),
        executionFormat: FORMAT2,
        idempotencyKey: `t08207-${door}-idempotency`,
      })

      expect(response.status).toBe(202)
      expect(await response.clone().json()).toMatchObject({ executionFormat: FORMAT2 })
      expect(captured).toHaveLength(1)
      expect(captured[0]).toMatchObject({
        executionFormat: FORMAT2,
        dispatchIdempotencyKey: `t08207-${door}-idempotency`,
      })
      expect(captured[0]).not.toHaveProperty('runId')
      expect(captured[0]?.format2RequestHash).toEqual(expect.any(String))
    }
  )

  test('refuses a same /v1/turns key when its selector changes before dispatch', async () => {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-08207'
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const key = 't08207-selector-frozen-key'
    const now = new Date().toISOString()
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runs.insert({
        runId: 'run-t08207-format1',
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'headless',
        status: 'queued',
        acceptedAt: now,
        updatedAt: now,
        dispatchIdempotencyKey: key,
        executionFormat: 'format1',
      })
    } finally {
      db.close()
    }
    Reflect.set(server!, 'dispatchTurnForSession', async () => {
      throw new Error('selector mismatch must refuse before dispatch')
    })
    const response = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'do not dispatch',
      runtimeIntent: headlessBrokerIntent(),
      idempotencyKey: key,
      executionFormat: FORMAT2,
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: {
        code: 'runtime_unavailable',
        detail: {
          code: 'execution_format_mismatch',
          frozenExecutionFormat: 'format1',
          selectedExecutionFormat: FORMAT2,
          idempotencyKey: key,
        },
      },
    })
  })

  test.each([
    { frozen: 'format1' as const, selected: FORMAT2 },
    { frozen: FORMAT2, selected: 'format1' as const },
  ])(
    'refuses a live $frozen invocation when dispatch selects $selected',
    async ({ frozen, selected }) => {
      const scopeRef = 'agent:cody:project:hrc-runtime:task:T-08207'
      const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
      seedLiveBrokerInvocation(fixture, {
        hostSessionId,
        scopeRef,
        generation,
        executionFormat: frozen,
      })

      const response = await fixture.postJson('/v1/turns', {
        hostSessionId,
        prompt: 'do not cross execution formats',
        runtimeIntent: headlessBrokerIntent(),
        executionFormat: selected,
        ...(selected === FORMAT2 ? { idempotencyKey: 't08207-live-format-key' } : {}),
      })

      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({
        error: {
          code: 'runtime_unavailable',
          detail: {
            code: 'execution_format_mismatch',
            frozenExecutionFormat: frozen,
            selectedExecutionFormat: selected,
          },
        },
      })
    }
  )

  test('refuses a broker response whose invocation has no persisted frozen format', async () => {
    const { hostSessionId } = await fixture.resolveSession(
      'agent:cody:project:hrc-runtime:task:T-08207'
    )
    Reflect.set(server!, 'dispatchTurnForSession', async () =>
      Response.json({
        hostSessionId,
        generation: 1,
        runtimeId: 'rt-unproved-format',
        transport: 'headless',
        status: 'accepted',
        inputId: 'input-unproved-format',
        startIdentity: { kind: 'broker', invocationId: 'inv-unproved-format' },
        observation: {
          broker: {
            selector: {
              invocationId: 'inv-unproved-format',
              runtimeId: 'rt-unproved-format',
              generation: 1,
            },
            afterSeq: 0,
          },
        },
      })
    )

    const response = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'refuse unproved invocation format',
      runtimeIntent: headlessBrokerIntent(),
      executionFormat: FORMAT2,
      idempotencyKey: 't08207-unproved-format-key',
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { code: 'runtime_unavailable', detail: { code: 'execution_format_unproved' } },
    })
  })
})

describe('T-08207 public broker-session format echo', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t08207-open-format-echo-')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  test('echoes the persisted broker invocation format instead of the request', async () => {
    const scopeRef = 'agent:cody:project:hrc-runtime:task:T-08207'
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const broker = seedLiveBrokerInvocation(fixture, {
      hostSessionId,
      scopeRef,
      generation,
      executionFormat: FORMAT2,
    })
    Reflect.set(server!, 'openHeadlessBrokerSessionForSession', async () => {
      const runtime = server!.db.runtimes.getByRuntimeId(broker.runtimeId)
      if (runtime === null) throw new Error('missing seeded broker runtime')
      return runtime
    })

    const response = await fixture.postJson('/v1/broker-sessions/open', {
      hostSessionId,
      runtimeIntent: headlessBrokerIntent(),
      executionFormat: 'format1',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      startIdentity: { kind: 'broker', invocationId: broker.invocationId },
      executionFormat: FORMAT2,
    })
  })
})

describe('T-08207 format1 sealed HTTP doors', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t08207-sealed-doors-')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  test.each([
    '/v1/runtimes/ensure',
    '/v1/runtimes/start',
    '/v1/runs/prepare-attached',
    '/v1/runs/resume-attached',
    '/v1/turns/by-selector',
    '/v1/messages',
    '/v1/app-sessions/ensure',
    '/v1/participants/attach',
    '/v1/participants/register',
  ])('rejects executionFormat before any format1-only route can act: %s', async (path) => {
    const response = await fixture.postJson(path, { executionFormat: FORMAT2 })

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: {
        code: HrcErrorCode.EXECUTION_FORMAT_UNSUPPORTED_DOOR,
        detail: { field: 'executionFormat', path },
      },
    })
  })
})
