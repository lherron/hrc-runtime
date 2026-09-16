import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import { persistStartGraph } from '../broker/controller/persistence.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { isLaunchCarriedInvokeCorrelationJson } from '../server-types.js'
import {
  makeCompileResponse,
  makeIdentity,
  makeInteractiveTmuxProfile,
} from './broker-compile-fixtures.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

// T-08541: a cold submission-door birth whose driver carries the caller body as
// the start request's `initialInput` (codex-app-server) has no argv launch
// marker. The broker admits that input as submission `initialInput.inputId`, so
// the start graph must record it as the run's broker submission identity;
// otherwise the door outlives the executed launch turn and answers 503.

const SCOPE = 'agent:sparky:project:hrc-runtime'
const CALLER = 'reply with exactly COLD-INVOKE-A and stop.'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08541-cold-invoke-identity-')
  server = await createHrcServer(
    fixture.serverOpts({
      claudeCodeTmuxBrokerEnabled: true,
      brokerDurableIpcEnabled: false,
      otelListenerEnabled: false,
    })
  )
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

function codexIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', id: 'codex-cli', interactive: true },
    execution: { preferredMode: 'interactive', allowInteractiveSurfaceReuse: false },
  }
}

function persistInitialInputStart(
  db: HrcDatabase,
  session: HrcSessionRecord,
  suffix: string,
  submissionDoor: 'invoke' | 'enqueue' | 'steer' | 'preempt' | undefined,
  runId = `run-t08541-${suffix}`
) {
  const identity = makeIdentity({
    hostSessionId: session.hostSessionId as RuntimeIdentityAllocation['hostSessionId'],
    generation: session.generation,
    runtimeId: `rt-t08541-${suffix}` as RuntimeIdentityAllocation['runtimeId'],
    invocationId: `inv-t08541-${suffix}` as RuntimeIdentityAllocation['invocationId'],
    operationId: `op-t08541-${suffix}` as RuntimeIdentityAllocation['operationId'],
    runId: runId as RuntimeIdentityAllocation['runId'],
    initialInputId: `input-t08541-${suffix}` as RuntimeIdentityAllocation['initialInputId'],
  })
  const { profile, startRequest } = makeInteractiveTmuxProfile(identity, {
    brokerDriver: 'codex-app-server',
    withInitialInput: true,
  })
  const compileResponse = makeCompileResponse(identity, [profile])
  if (!compileResponse.ok) throw new Error('T-08541 fixture rejected')
  const graph = persistStartGraph(
    { db, now: fixture.now, serverInstanceId: 'srv-t08541' },
    {
      plan: compileResponse.plan,
      profile,
      startRequest,
      specHash: profile.harnessInvocation.specHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      identity,
      ...(submissionDoor !== undefined ? { submissionDoor } : {}),
    } as Parameters<typeof persistStartGraph>[1],
    {
      protocolVersion: 'harness-broker/0.2',
      capabilities: {},
      drivers: [],
    } as unknown as Parameters<typeof persistStartGraph>[2],
    undefined
  )
  return { identity, graph, initialInputId: String(identity.initialInputId) }
}

describe('T-08541 an initialInput-carried cold birth records its broker submission identity', () => {
  for (const door of ['invoke', 'enqueue', 'steer', 'preempt'] as const) {
    it(`stamps initialInput.inputId as the ${door} run's broker submission id`, async () => {
      const resolved = await fixture.resolveSession(SCOPE)
      const internal = server as unknown as HrcServerInstanceForHandlers
      const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
      if (session === null) throw new Error('T-08541 fixture session missing')

      const { identity, initialInputId } = persistInitialInputStart(
        internal.db,
        session,
        `graph-${door}`,
        door
      )
      const run = internal.db.runs.getByRunId(String(identity.runId))

      expect(run?.dispatchedInputId).toBe(initialInputId)
      expect(run?.brokerSubmissionId).toBe(initialInputId)
      // The argv launch marker stays exclusive to input-less launches.
      expect(
        isLaunchCarriedInvokeCorrelationJson(
          internal.db.runs.getCorrelationJson(String(identity.runId))
        )
      ).toBe(false)
    })
  }

  it('leaves a start with no submission door unchanged', async () => {
    const resolved = await fixture.resolveSession(SCOPE)
    const internal = server as unknown as HrcServerInstanceForHandlers
    const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
    if (session === null) throw new Error('T-08541 fixture session missing')

    const { identity, initialInputId } = persistInitialInputStart(
      internal.db,
      session,
      'no-door',
      undefined
    )
    const run = internal.db.runs.getByRunId(String(identity.runId))

    expect(run?.dispatchedInputId).toBe(initialInputId)
    expect(run?.brokerSubmissionId).toBeUndefined()
  })

  it('answers a cold invoke admitted with the launch submission after the launch turn completed', async () => {
    const resolved = await fixture.resolveSession(SCOPE)
    const internal = server as unknown as HrcServerInstanceForHandlers
    const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
    if (session === null) throw new Error('T-08541 fixture session missing')
    const runId = 'run-t08541-door'
    let launchInputId: string | undefined
    let independentSubmissions = 0

    internal.startInteractiveTmuxBrokerRuntime = async (
      startSession: HrcSessionRecord,
      _intent: HrcRuntimeIntent,
      startRunId: string,
      options
    ) => {
      const { graph, initialInputId } = persistInitialInputStart(
        internal.db,
        startSession,
        'door',
        'invoke',
        startRunId
      )
      launchInputId = initialInputId
      options.onColdBirthPromptRoute?.(true)
      await options.onAccepted?.(graph.runtime)
      // The launch turn executes and completes. Nothing later stamps an
      // initialInput run's submission identity, so the door must already have it.
      internal.db.runs.markCompleted(startRunId, {
        status: 'completed',
        completedAt: fixture.now(),
        updatedAt: fixture.now(),
      })
      return graph.runtime
    }
    internal.executeInteractiveBrokerInputTurn = async () => {
      independentSubmissions += 1
      throw new Error('cold caller body was submitted a second time')
    }
    internal.publishPresentation = async () => undefined

    const response = await internal.handleInteractiveTmuxBrokerDispatchTurn(
      session,
      codexIntent(),
      CALLER,
      runId,
      {
        flagEnvName: 'HRC_CODEX_APP_SERVER_BROKER_ENABLED',
        allowedBrokerDriver: 'codex-app-server',
        waitForCompletion: true,
        submissionDoor: 'invoke',
        coldBirthPromptMode: 'append-to-priming',
      }
    )
    const body = (await response.json()) as {
      runId?: string
      submissionId?: string
      admission?: string
    }

    expect(independentSubmissions).toBe(0)
    expect(body.runId).toBe(runId)
    expect(body.submissionId).toBe(launchInputId)
    expect(body.admission).toBe('admitted')
  })
})
