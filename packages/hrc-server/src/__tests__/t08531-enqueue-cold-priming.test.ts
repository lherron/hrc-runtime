import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import { persistStartGraph } from '../broker/controller/persistence.js'
import { BrokerEventMapper } from '../broker/event-mapper.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { isLaunchCarriedInvokeCorrelationJson } from '../server-types.js'
import {
  makeHrcPolicy,
  makeIdentity,
  makeSelectedExecutionPlan,
  makeSelectedInteractiveTmuxExecution,
} from './broker-compile-fixtures.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:clod:project:agents'
const PRIMING = 'You are Clod. Wait for instructions.'
const CALLER = 'Smoke check of your priming prompt. Reply with exactly the word PONG.'

let fixture: HrcServerTestFixture
let server: HrcServer

function claudeIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'anthropic', id: 'claude-code', interactive: false },
    execution: {
      preferredMode: 'headless',
      allowInteractiveSurfaceReuse: false,
    },
  }
}

function brokerEnvelope(
  invocationId: string,
  seq: number,
  type: InvocationEventEnvelope['type'],
  payload: Record<string, unknown>
): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: new Date(Date.parse(fixture.now()) + seq).toISOString(),
    type,
    payload,
  } as InvocationEventEnvelope
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08531-enqueue-cold-priming-')
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

function coldRuntime(session: HrcSessionRecord, suffix: string): HrcRuntimeSnapshot {
  return {
    runtimeId: `rt-t08531-${suffix}`,
    runtimeKind: 'harness',
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'starting',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: `op-t08531-${suffix}`,
    activeInvocationId: `inv-t08531-${suffix}`,
    createdAt: fixture.now(),
    updatedAt: fixture.now(),
  }
}

describe('T-08531 cold enqueue on claude-code-tmux carries priming and caller in one launch turn', () => {
  for (const door of ['enqueue', 'steer'] as const) {
    it(`answers the ${door} door with the launch turn submission and never submits the body again`, async () => {
      const resolved = await fixture.resolveSession(SCOPE)
      const internal = server as unknown as HrcServerInstanceForHandlers
      const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
      if (session === null) throw new Error('T-08531 fixture session missing')
      const runtime = coldRuntime(session, 'single-turn')
      const runId = `run-t08531-single-turn-${door}`
      const launchSubmissionId = 'human_submission_t08531_1'
      let independentSubmissions = 0
      internal.startInteractiveTmuxBrokerRuntime = async (
        startSession: HrcSessionRecord,
        _intent: HrcRuntimeIntent,
        startRunId: string,
        options
      ) => {
        expect(options.coldBirthPrompt).toBe(CALLER)
        expect(options.includePrimingForColdBirthPrompt).toBe(true)
        options.onColdBirthPromptRoute?.(true)
        internal.db.runtimes.insert(runtime)
        internal.db.runs.insert({
          runId: startRunId,
          hostSessionId: startSession.hostSessionId,
          runtimeId: runtime.runtimeId,
          scopeRef: startSession.scopeRef,
          laneRef: startSession.laneRef,
          generation: startSession.generation,
          transport: 'tmux',
          status: 'accepted',
          acceptedAt: fixture.now(),
          updatedAt: fixture.now(),
          invocationId: runtime.activeInvocationId,
          operationId: runtime.activeOperationId,
        })
        await options.onAccepted?.(runtime)
        // The harness observes the launch turn after boot resolves; the door must
        // wait for that submission identity instead of minting a second input.
        setTimeout(() => {
          try {
            internal.db.runs.update(startRunId, {
              brokerSubmissionId: launchSubmissionId,
              updatedAt: fixture.now(),
            })
          } catch {
            // The test already failed and closed the store.
          }
        }, 50)
        return runtime
      }
      internal.executeInteractiveBrokerInputTurn = async () => {
        independentSubmissions += 1
        throw new Error('cold caller body was submitted a second time')
      }
      internal.publishPresentation = async () => undefined

      const response = await internal.handleInteractiveTmuxBrokerDispatchTurn(
        session,
        claudeIntent(),
        CALLER,
        runId,
        {
          flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
          allowedBrokerDriver: 'claude-code-tmux',
          waitForCompletion: true,
          submissionDoor: door,
          coldBirthPromptMode: 'append-to-priming',
        }
      )
      await Bun.sleep(0)
      const body = (await response.json()) as { submissionId?: string; admission?: string }

      expect(independentSubmissions).toBe(0)
      expect(body.submissionId).toBe(launchSubmissionId)
      expect(body.admission).toBe('admitted')
    })
  }

  for (const door of ['enqueue', 'steer'] as const) {
    it(`binds the input-less launch bracket to the ${door} run and settles its submission executed`, async () => {
      const resolved = await fixture.resolveSession(SCOPE)
      const internal = server as unknown as HrcServerInstanceForHandlers & { db: HrcDatabase }
      const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
      if (session === null) throw new Error('T-08531 fixture session missing')

      const identity = makeIdentity({
        hostSessionId: session.hostSessionId as RuntimeIdentityAllocation['hostSessionId'],
        generation: session.generation,
        runtimeId: 'rt-t08531-ledger' as RuntimeIdentityAllocation['runtimeId'],
        invocationId: 'inv-t08531-ledger' as RuntimeIdentityAllocation['invocationId'],
        operationId: 'op-t08531-ledger' as RuntimeIdentityAllocation['operationId'],
        runId: `run-t08531-ledger-${door}` as RuntimeIdentityAllocation['runId'],
        initialInputId: undefined,
      })
      const { execution } = makeSelectedInteractiveTmuxExecution(identity, {
        launchInitialPrompt: `${PRIMING}\n\n${CALLER}`,
        withInitialInput: false,
      })

      persistStartGraph(
        {
          db: internal.db,
          now: fixture.now,
          serverInstanceId: 'srv-t08531',
        },
        {
          execution,
          plan: makeSelectedExecutionPlan(),
          hrcPolicy: makeHrcPolicy(),
          identity,
          submissionDoor: door,
        } as Parameters<typeof persistStartGraph>[1],
        {
          protocolVersion: 'harness-broker/0.2',
          capabilities: {},
          drivers: [],
        } as unknown as Parameters<typeof persistStartGraph>[2],
        undefined
      )
      const runId = String(identity.runId)
      expect(isLaunchCarriedInvokeCorrelationJson(internal.db.runs.getCorrelationJson(runId))).toBe(
        true
      )
      internal.db.brokerInvocations.update(String(identity.invocationId), {
        capabilitiesJson: JSON.stringify({ bracketMintingMode: 'harness-evidence' }),
        updatedAt: fixture.now(),
      })

      const mapper = new BrokerEventMapper({ db: internal.db, now: fixture.now })
      const turnId = 'turn-t08531-ledger'
      const submissionId = 'human_submission_t08531_1'
      const started = mapper.apply(
        brokerEnvelope(String(identity.invocationId), 1, 'turn.started', {
          turnId,
          source: 'hook-observed',
        })
      )
      mapper.apply(
        brokerEnvelope(String(identity.invocationId), 2, 'submission.executed', {
          submissionId,
          turnId,
        })
      )

      expect(started.lifecycleEvents[0]?.runId).toBe(runId)
      expect(internal.db.runs.getByRunId(runId)?.brokerSubmissionId).toBe(submissionId)

      mapper.apply(
        brokerEnvelope(String(identity.invocationId), 3, 'turn.completed', {
          turnId,
          status: 'completed',
        })
      )

      expect(internal.db.runs.getByRunId(runId)?.status).toBe('completed')
      expect(
        internal.db.runtimes.getByRuntimeId(String(identity.runtimeId))?.activeRunId
      ).toBeUndefined()
    })
  }
})
