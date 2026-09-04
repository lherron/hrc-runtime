import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import type {
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
} from 'spaces-aspc-protocol'
import type {
  InvocationEventEnvelope,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import type { RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import { AspcFacadeBrokerClient } from '../agent-spaces-adapter/aspc-facade-client.js'
import { persistStartGraph } from '../broker/controller/persistence.js'
import { BrokerEventMapper } from '../broker/event-mapper.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import {
  makeCompileResponse,
  makeIdentity,
  makeInteractiveTmuxProfile,
} from './broker-compile-fixtures.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:slugger:project:hrc-runtime:task:slugs:role:probe'
const PRIMING = 'You are the slugger agent. Reply with only a kebab-case slug.'
const CALLER = 'Slug this title.\n\n<title>Change chief color scheme</title>'

let fixture: HrcServerTestFixture
let server: HrcServer
let facadeSpy: ReturnType<typeof spyOn> | undefined

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

function redirectedClaudeIntent(): HrcRuntimeIntent {
  const intent = claudeIntent()
  return {
    ...intent,
    harness: { ...intent.harness, interactive: true },
    execution: { ...intent.execution, preferredMode: 'interactive' },
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
  fixture = await createHrcTestFixture('hrc-t08004-invoke-cold-priming-')
  server = await createHrcServer(
    fixture.serverOpts({
      claudeCodeTmuxBrokerEnabled: true,
      brokerDurableIpcEnabled: false,
      otelListenerEnabled: false,
    })
  )
})

afterEach(async () => {
  facadeSpy?.mockRestore()
  facadeSpy = undefined
  await server.stop()
  await fixture.cleanup()
})

describe('T-08004 cold invoke carries nonempty priming and caller in one native turn', () => {
  it('selects priming-plus-caller launch carriage only for the cold invoke route', async () => {
    const resolved = await fixture.resolveSession(SCOPE)
    const internal = server as unknown as HrcServerInstanceForHandlers
    let coldBirthPromptMode: unknown

    internal.handleInteractiveTmuxBrokerDispatchTurn = async (
      session,
      _intent,
      _prompt,
      runId,
      options
    ) => {
      coldBirthPromptMode = options.coldBirthPromptMode
      return Response.json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: 'rt-t08004-route',
        transport: 'tmux',
        status: 'started',
        supportsInFlightInput: true,
      })
    }

    const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
    if (session === null) throw new Error('T-08004 fixture session missing')
    await internal.dispatchTurnForSession(session, claudeIntent(), CALLER, {
      waitForCompletion: false,
      submissionDoor: 'invoke',
    })

    expect(coldBirthPromptMode).toBe('append-to-priming')
  })

  it('hands the caller to the interactive compiler with priming enabled', async () => {
    let compileRequest: AspcCompileHarnessInvocationRequest['compileRequest'] | undefined
    let startedRequest: InvocationStartRequest | undefined
    facadeSpy = spyOn(AspcFacadeBrokerClient, 'start').mockImplementation(
      async () =>
        ({
          hello: async () => ({
            protocolVersion: ASPC_PROTOCOL_VERSION,
            facadeInfo: { name: 'aspc-facade', version: 't08004-test' },
            capabilities: { compileHarnessInvocation: true, cohostedBroker: true },
          }),
          compileHarnessInvocation: async (
            request: AspcCompileHarnessInvocationRequest
          ): Promise<AspcCompileHarnessInvocationResponse> => {
            compileRequest = request.compileRequest
            const identity = request.compileRequest.identity as RuntimeIdentityAllocation
            const { profile, startRequest } = makeInteractiveTmuxProfile(identity, {
              launchInitialPrompt: `${PRIMING}\n\n${request.compileRequest.materialization.initialPrompt}`,
              withInitialInput: false,
            })
            const compileResponse = makeCompileResponse(identity, [profile])
            if (!compileResponse.ok) throw new Error('T-08004 compile fixture rejected')
            return {
              schemaVersion: 'aspc-compile-harness-invocation-response/v1',
              ok: true,
              compileResponse,
              plan: compileResponse.plan,
              selectedProfile: profile,
              startRequest,
              dispatchRequest: { startRequest },
              diagnostics: compileResponse.diagnostics,
            }
          },
          close: async () => undefined,
        }) as unknown as AspcFacadeBrokerClient
    )

    const resolved = await fixture.resolveSession(SCOPE)
    const internal = server as unknown as HrcServerInstanceForHandlers
    const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
    if (session === null) throw new Error('T-08004 fixture session missing')
    const runtime: HrcRuntimeSnapshot = {
      runtimeId: 'rt-t08004-compile',
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
      activeOperationId: 'op-t08004-compile',
      activeInvocationId: 'inv-t08004-compile',
      createdAt: fixture.now(),
      updatedAt: fixture.now(),
    }
    internal.getHarnessBrokerController = () =>
      ({
        start: async (input: { startRequest: InvocationStartRequest }) => {
          startedRequest = input.startRequest
          return { ok: true as const, runtime }
        },
      }) as ReturnType<HrcServerInstanceForHandlers['getHarnessBrokerController']>

    await internal.startInteractiveTmuxBrokerRuntime(
      session,
      redirectedClaudeIntent(),
      'run-t08004',
      {
        flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
        allowedBrokerDriver: 'claude-code-tmux',
        coldBirthPrompt: CALLER,
        includePrimingForColdBirthPrompt: true,
        submissionDoor: 'invoke',
      }
    )

    expect(compileRequest?.materialization.initialPrompt).toBe(CALLER)
    expect(compileRequest?.materialization.omitPriming).toBeUndefined()
    expect(startedRequest?.spec.launch?.initialPrompt).toBe(`${PRIMING}\n\n${CALLER}`)
    expect(startedRequest?.initialInput).toBeUndefined()
  })

  it('returns from cold launch without admitting an independent caller submission', async () => {
    const resolved = await fixture.resolveSession(SCOPE)
    const internal = server as unknown as HrcServerInstanceForHandlers
    const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
    if (session === null) throw new Error('T-08004 fixture session missing')
    const runtime: HrcRuntimeSnapshot = {
      runtimeId: 'rt-t08004-single-turn',
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
      activeOperationId: 'op-t08004-single-turn',
      activeInvocationId: 'inv-t08004-single-turn',
      createdAt: fixture.now(),
      updatedAt: fixture.now(),
    }
    let independentSubmissions = 0
    internal.startInteractiveTmuxBrokerRuntime = async (
      _session: HrcSessionRecord,
      _intent: HrcRuntimeIntent,
      _runId: string,
      options
    ) => {
      options.onColdBirthPromptRoute?.(true)
      await options.onAccepted?.(runtime)
      return runtime
    }
    internal.executeInteractiveBrokerInputTurn = async () => {
      independentSubmissions += 1
      throw new Error('cold caller was submitted a second time')
    }
    internal.publishPresentation = async () => undefined

    const response = await internal.handleInteractiveTmuxBrokerDispatchTurn(
      session,
      claudeIntent(),
      CALLER,
      'run-t08004-single-turn',
      {
        waitForCompletion: false,
        submissionDoor: 'invoke',
        coldBirthPromptMode: 'append-to-priming',
      }
    )
    await Bun.sleep(0)

    expect(response.status).toBe(200)
    expect(independentSubmissions).toBe(0)
    expect(
      internal.db.brokerInvocationEvents
        .listByInvocationId(runtime.activeInvocationId ?? '')
        .filter((event) => event.type === 'submission.cancelled')
    ).toHaveLength(0)
  })

  it('binds the input-less launch bracket to the invoke run and releases it at terminal', async () => {
    const resolved = await fixture.resolveSession(SCOPE)
    const internal = server as unknown as HrcServerInstanceForHandlers & { db: HrcDatabase }
    const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
    if (session === null) throw new Error('T-08004 fixture session missing')

    const identity = makeIdentity({
      hostSessionId: session.hostSessionId as RuntimeIdentityAllocation['hostSessionId'],
      generation: session.generation,
      runtimeId: 'rt-t08004-ledger' as RuntimeIdentityAllocation['runtimeId'],
      invocationId: 'inv-t08004-ledger' as RuntimeIdentityAllocation['invocationId'],
      operationId: 'op-t08004-ledger' as RuntimeIdentityAllocation['operationId'],
      runId: 'run-t08004-ledger' as RuntimeIdentityAllocation['runId'],
      initialInputId: undefined,
    })
    const { profile, startRequest } = makeInteractiveTmuxProfile(identity, {
      launchInitialPrompt: `${PRIMING}\n\n${CALLER}`,
      withInitialInput: false,
    })
    const compileResponse = makeCompileResponse(identity, [profile])
    if (!compileResponse.ok) throw new Error('T-08004 ledger fixture rejected')

    persistStartGraph(
      {
        db: internal.db,
        now: fixture.now,
        serverInstanceId: 'srv-t08004',
      },
      {
        plan: compileResponse.plan,
        profile,
        startRequest,
        specHash: profile.harnessInvocation.specHash,
        startRequestHash: profile.harnessInvocation.startRequestHash,
        identity,
        submissionDoor: 'invoke',
      } as Parameters<typeof persistStartGraph>[1],
      {
        protocolVersion: 'harness-broker/0.2',
        capabilities: {},
        drivers: [],
      } as unknown as Parameters<typeof persistStartGraph>[2],
      undefined
    )
    internal.db.brokerInvocations.update(String(identity.invocationId), {
      capabilitiesJson: JSON.stringify({ bracketMintingMode: 'harness-evidence' }),
      updatedAt: fixture.now(),
    })

    const mapper = new BrokerEventMapper({ db: internal.db, now: fixture.now })
    const turnId = 'turn-t08004-ledger'
    const submissionId = 'human_submission_t08004_1'
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

    expect(started.lifecycleEvents[0]?.runId).toBe(String(identity.runId))
    expect(internal.db.runs.getByRunId(String(identity.runId))?.status).toBe('running')
    expect(internal.db.runs.getByRunId(String(identity.runId))?.brokerSubmissionId).toBe(
      submissionId
    )

    mapper.apply(
      brokerEnvelope(String(identity.invocationId), 3, 'turn.completed', {
        turnId,
        status: 'completed',
      })
    )

    expect(internal.db.runs.getByRunId(String(identity.runId))?.status).toBe('completed')
    expect(
      internal.db.runtimes.getByRuntimeId(String(identity.runtimeId))?.activeRunId
    ).toBeUndefined()
    expect(
      internal.db.brokerInvocationEvents
        .listByInvocationId(String(identity.invocationId))
        .filter((event) => event.type === 'submission.cancelled')
    ).toHaveLength(0)
  })
})
