/** T-08576 R-B1-R-B6 and R-B7(a-f) birth-boundary acceptance tests. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HrcRuntimeIntent } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { evaluateServerLifecycleAuthorization } from '../../../hrc-cli/src/cli-runtime/shutdown-intent'
import { buildHrcCorrelationEnv } from '../agent-spaces-adapter/cli-adapter'
import { BrokerEventMapper } from '../broker/event-mapper'
import { launchCarriedInvokeCorrelationJson } from '../server-types'
import { dispatchTurnForSession } from '../turn-dispatch-handlers'
import {
  APP_ID,
  KEY,
  NOW,
  PARTIAL_LIFECYCLE_ENVELOPE_MESSAGE,
  adversarialIntent,
  appHost,
  baseIntent,
  bootAspdBirthServer,
  capturedRefusal,
  counts,
  dispatchedIdentityEnv,
  expectBirthAutoDispatch,
  forbiddenIntent,
  frozenPreparations,
  hostEffectCounts,
  identityProjection,
  internal,
  launchCalls,
  ledger,
  post,
  seedAppIdentity,
  seedRun,
  setUpAppSessionBirthFixture,
  settle,
  tearDownAppSessionBirthFixture,
} from './fixtures/app-session-birth.fixture'

beforeEach(setUpAppSessionBirthFixture)
afterEach(tearDownAppSessionBirthFixture)

describe('T-08576 app-session birth identity boundary', () => {
  // Rev-8 inventory context for future sessions:
  // - R-B7(f2) is not reachable through the app route exercised here: both requested fixture
  //   variants are observed at the handler seam as interactive-tmux-broker + enqueue (f1).
  // - R-B7(g8)'s app/app and app/command collisions are pinned by (i)/(m); its generic run-insert
  //   arm is the tokenless reserved-id case in store.app-session-scope.test.ts.
  // - R-B7(t) P9 is in app-session-create-atomic, P10 in the X crossing matrix, P12 in the
  //   strict-grammar controls, and P14 in app-session-read-surfaces' allowed interrupt control.
  it('R-B1/R-B2/R-B4 binds ensure birth correlation, launch env, persisted intent and frozen preparation', async () => {
    await bootAspdBirthServer()
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: adversarialIntent() },
    })
    expect({ status: response.status, error: response.body.error }).toEqual({
      status: 200,
      error: undefined,
    })
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)

    const managed = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
    const hostSessionId = managed?.activeHostSessionId as string
    const expectedCorrelation = { hostSessionId, generation: 1 }
    const persisted = internal.db.sessions.getByHostSessionId(hostSessionId)?.lastAppliedIntentJson
    const frozen = frozenPreparations(hostSessionId)[0]
    expect(persisted?.placement.correlation).toEqual(expectedCorrelation)
    expect(frozen?.intent?.placement?.correlation).toEqual(expectedCorrelation)
    expect(frozen?.admission?.startRequest).toEqual(ledger?.startCalls[0]?.request)
    expect(identityProjection(dispatchedIdentityEnv())).toEqual({
      AGENT_HOST_SESSION_ID: hostSessionId,
      HRC_HOST_SESSION_ID: hostSessionId,
      AGENT_GENERATION: '1',
      HRC_GENERATION: '1',
    })
    expectBirthAutoDispatch({
      hostSessionId,
      runtimeId: response.body.runtimeId,
      body: '',
    })
  })

  it('R-B5 agent aspd birth preserves its compile correlation and dispatch identity', async () => {
    await bootAspdBirthServer()
    const resolved = await post('/v1/sessions/resolve', {
      sessionRef: 'agent:smokey:project:hrc-runtime:task:T-08576/lane:b5',
      create: true,
      summonIntent: 'explicit_local',
    })
    expect(resolved.status).toBe(200)
    const intent = baseIntent()
    ;(intent.placement as Record<string, unknown>).correlation = {
      sessionRef: {
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-08576',
        laneRef: 'lane:b5',
      },
      hostSessionId: resolved.body.hostSessionId,
      generation: 1,
      runId: 'run-agent-b5',
    }
    const started = await post('/v1/runtimes/ensure', {
      hostSessionId: resolved.body.hostSessionId,
      intent,
    })
    expect(started.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)
    const frozen = frozenPreparations(resolved.body.hostSessionId)[0]
    expect(frozen?.intent?.placement?.correlation).toEqual(intent.placement.correlation)
    expect(identityProjection(dispatchedIdentityEnv())).toMatchObject({
      HRC_SESSION_REF: 'agent:smokey:project:hrc-runtime:task:T-08576/lane:b5',
      HRC_HOST_SESSION_ID: resolved.body.hostSessionId,
      HRC_GENERATION: '1',
    })
  })

  it('R-B5 T-08574 correlation env keeps app correlation unprojectable and agent correlation unchanged', () => {
    const previewIntent = {
      ...baseIntent(),
      harness: { provider: 'anthropic' as const, id: 'claude-code', interactive: true },
    }
    expect(() =>
      buildHrcCorrelationEnv({
        ...previewIntent,
        placement: {
          ...previewIntent.placement,
          correlation: { sessionRef: { scopeRef: 'app:t08576', laneRef: 'lane:preview' } },
        },
      } as HrcRuntimeIntent)
    ).toThrow()

    const agentIntent = {
      ...previewIntent,
      placement: {
        ...previewIntent.placement,
        correlation: {
          sessionRef: {
            scopeRef: 'agent:smokey:project:hrc-runtime:task:T-08576',
            laneRef: 'lane:preview',
          },
          hostSessionId: 'hsid-preview',
          generation: 7,
          runId: 'run-preview',
        },
      },
    } as HrcRuntimeIntent
    expect(identityProjection(buildHrcCorrelationEnv(agentIntent))).toMatchObject({
      AGENT_SESSION_REF: 'agent:smokey:project:hrc-runtime:task:T-08576/lane:preview',
      HRC_SESSION_REF: 'agent:smokey:project:hrc-runtime:task:T-08576/lane:preview',
      AGENT_HOST_SESSION_ID: 'hsid-preview',
      HRC_HOST_SESSION_ID: 'hsid-preview',
      AGENT_GENERATION: '7',
      HRC_GENERATION: '7',
      AGENT_RUN_ID: 'run-preview',
      HRC_RUN_ID: 'run-preview',
    })
  })

  it('R-B6 refuses the actual composed grantless app birth envelope', async () => {
    await bootAspdBirthServer()
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
    })
    expect(response.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)

    const hostSessionId = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
      ?.activeHostSessionId as string
    const env = dispatchedIdentityEnv()
    expect(identityProjection(env)).toEqual({
      AGENT_HOST_SESSION_ID: hostSessionId,
      HRC_HOST_SESSION_ID: hostSessionId,
      AGENT_GENERATION: '1',
      HRC_GENERATION: '1',
    })
    const authorization = evaluateServerLifecycleAuthorization(env, 'must not authorize')
    expect(authorization).toEqual({
      allowed: false,
      message: PARTIAL_LIFECYCLE_ENVELOPE_MESSAGE,
    })
    expect((authorization as { callerKind?: string }).callerKind).not.toBe('operator')
    expectBirthAutoDispatch({
      hostSessionId,
      runtimeId: response.body.runtimeId,
      body: '',
    })
  })

  it('R-B6 refuses the actual composed granted app birth envelope', async () => {
    await bootAspdBirthServer()
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
      initialPrompt: 'capture granted lifecycle envelope',
    })
    expect(response.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)

    const hostSessionId = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
      ?.activeHostSessionId as string
    const env = dispatchedIdentityEnv()
    const runId = env.HRC_RUN_ID
    expect(identityProjection(env)).toEqual({
      AGENT_HOST_SESSION_ID: hostSessionId,
      HRC_HOST_SESSION_ID: hostSessionId,
      AGENT_RUN_ID: runId,
      HRC_RUN_ID: runId,
      AGENT_GENERATION: '1',
      HRC_GENERATION: '1',
    })
    expect(runId).toMatch(/^run-/)
    expect(internal.db.runs.getByRunId(runId)).toMatchObject({
      hostSessionId,
      generation: 1,
      runtimeId: response.body.runtimeId,
    })
    const authorization = evaluateServerLifecycleAuthorization(env, 'must not authorize')
    expect(authorization).toEqual({
      allowed: false,
      message: PARTIAL_LIFECYCLE_ENVELOPE_MESSAGE,
    })
    expect((authorization as { callerKind?: string }).callerKind).not.toBe('operator')
  })

  for (const channel of ['lockedEnv', 'env', 'dispatchEnv'] as const) {
    it(`R-B3 refuses placement.${channel} identity keys before creating any row`, async () => {
      const before = counts()
      const response = await post('/v1/app-sessions/ensure', {
        selector: { appId: APP_ID, appSessionKey: `entry-${channel}` },
        spec: { kind: 'harness', runtimeIntent: forbiddenIntent(channel) },
      })

      expect({
        status: response.status,
        reason: response.body.error?.detail?.reason,
        field: response.body.error?.detail?.field,
        keys: response.body.error?.detail?.keys,
        effects: counts(),
        launchCalls,
      }).toEqual({
        status: 422,
        reason: 'app-session-identity-env-forbidden',
        field: 'spec.runtimeIntent',
        keys: ['AGENT_ID'],
        effects: before,
        launchCalls: [],
      })
    })
  }

  it('R-B3 validates an entire apply request before writing its valid prefix', async () => {
    const before = counts()
    const response = await post('/v1/app-sessions/apply', {
      appId: APP_ID,
      sessions: [
        { appSessionKey: 'valid-prefix', spec: { kind: 'harness', runtimeIntent: baseIntent() } },
        {
          appSessionKey: 'forbidden-tail',
          spec: { kind: 'harness', runtimeIntent: forbiddenIntent('dispatchEnv') },
        },
      ],
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      field: response.body.error?.detail?.field,
      keys: response.body.error?.detail?.keys,
      effects: counts(),
      launchCalls,
    }).toEqual({
      status: 422,
      reason: 'app-session-identity-env-forbidden',
      field: 'spec.runtimeIntent',
      keys: ['AGENT_ID'],
      effects: before,
      launchCalls: [],
    })
  })

  it('R-B3 refuses forbidden identity env on an existing ensure before any effect', async () => {
    seedAppIdentity()
    const before = counts()
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: forbiddenIntent('env') },
      forceRestart: true,
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      field: response.body.error?.detail?.field,
      keys: response.body.error?.detail?.keys,
      effects: counts(),
      launchCalls,
    }).toEqual({
      status: 422,
      reason: 'app-session-identity-env-forbidden',
      field: 'spec.runtimeIntent',
      keys: ['AGENT_ID'],
      effects: before,
      launchCalls: [],
    })
  })

  it('R-B3 refuses a turns runtimeIntent identity override before birth', async () => {
    seedAppIdentity()
    const before = counts()
    const response = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must not launch',
      runtimeIntent: forbiddenIntent('dispatchEnv'),
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      field: response.body.error?.detail?.field,
      keys: response.body.error?.detail?.keys,
      effects: counts(),
      launchCalls,
    }).toEqual({
      status: 422,
      reason: 'app-session-identity-env-forbidden',
      field: 'runtimeIntent',
      keys: ['AGENT_ID'],
      effects: before,
      launchCalls: [],
    })
  })

  it('R-B3 refuses a clear-context relaunch spec before invalidation or rotation', async () => {
    seedAppIdentity()
    const before = counts()
    const beforeManaged = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
    const response = await post('/v1/app-sessions/clear-context', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      relaunch: true,
      spec: { kind: 'harness', runtimeIntent: forbiddenIntent('lockedEnv') },
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      field: response.body.error?.detail?.field,
      keys: response.body.error?.detail?.keys,
      effects: counts(),
      managed: internal.db.appManagedSessions.findByKey(APP_ID, KEY),
      launchCalls,
    }).toEqual({
      status: 422,
      reason: 'app-session-identity-env-forbidden',
      field: 'spec.runtimeIntent',
      keys: ['AGENT_ID'],
      effects: before,
      managed: beforeManaged,
      launchCalls: [],
    })
  })

  it('R-B3b rejects a stored forbidden intent at birth while preserving the identity', async () => {
    seedAppIdentity(forbiddenIntent('lockedEnv', 'HRC_SESSION_REF'))
    const before = counts()
    const beforeSession = internal.db.sessions.getByHostSessionId(appHost)
    const response = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must not launch',
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      field: response.body.error?.detail?.field,
      keys: response.body.error?.detail?.keys,
      effects: counts(),
      session: internal.db.sessions.getByHostSessionId(appHost),
      managedStatus: internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.status,
      launchCalls,
    }).toEqual({
      status: 422,
      reason: 'app-session-identity-env-forbidden',
      field: 'stored-or-supplied intent',
      keys: ['HRC_SESSION_REF'],
      effects: before,
      session: beforeSession,
      managedStatus: 'active',
      launchCalls: [],
    })
  })

  for (const status of ['completed', 'accepted'] as const) {
    it(`R-B7(${status === 'completed' ? 'c' : 'd'}) refuses a reused ${status} run id before launch`, async () => {
      seedAppIdentity()
      const runId = `run-t08576-${status}`
      seedRun(runId, status)
      const before = counts()
      const response = await post('/v1/app-sessions/turns', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        prompt: 'must not launch',
        runId,
      })

      expect({
        status: response.status,
        code: response.body.error?.code,
        reason: response.body.error?.detail?.reason,
        effects: counts(),
        launchCalls,
      }).toEqual({
        status: 409,
        code: 'run_mismatch',
        reason: 'app-session-run-id-reused',
        effects: before,
        launchCalls: [],
      })
    })
  }

  it('R-B7(a) forceRestart ignores a supplied historical correlation run id', async () => {
    await bootAspdBirthServer()
    const historicalRunId = 'run-t08576-a-historical'
    seedAppIdentity(adversarialIntent(historicalRunId))
    seedRun(historicalRunId, 'completed')
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: adversarialIntent(historicalRunId) },
      forceRestart: true,
    })
    expect(response.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)
    expect(frozenPreparations(appHost)[0]?.intent?.placement?.correlation).toEqual({
      hostSessionId: appHost,
      generation: 1,
    })
    expect(dispatchedIdentityEnv()).not.toHaveProperty('HRC_RUN_ID')
    expect(dispatchedIdentityEnv()).not.toHaveProperty('AGENT_RUN_ID')
    expectBirthAutoDispatch({
      hostSessionId: appHost,
      runtimeId: response.body.runtimeId,
      body: '',
    })
  })

  it('R-B7(b) clear-context relaunch ignores a stored historical correlation run id', async () => {
    await bootAspdBirthServer()
    const historicalRunId = 'run-t08576-b-historical'
    seedAppIdentity(adversarialIntent(historicalRunId))
    seedRun(historicalRunId, 'completed')
    const response = await post('/v1/app-sessions/clear-context', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      relaunch: true,
    })
    expect(response.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)
    const currentHost = internal.db.appManagedSessions.findByKey(APP_ID, KEY)?.activeHostSessionId
    expect(frozenPreparations(currentHost as string)[0]?.intent?.placement?.correlation).toEqual({
      hostSessionId: currentHost,
      generation: 2,
    })
    expect(dispatchedIdentityEnv()).not.toHaveProperty('HRC_RUN_ID')
    expect(dispatchedIdentityEnv()).not.toHaveProperty('AGENT_RUN_ID')
  })

  it('R-B7(e) direct dispatch backstop refuses an existing app run before effects', async () => {
    await bootAspdBirthServer()
    seedAppIdentity()
    const runId = 'run-t08576-direct-existing'
    seedRun(runId, 'completed')
    const before = counts()
    const session = internal.db.sessions.getByHostSessionId(appHost)!
    const refusal = await capturedRefusal(() =>
      dispatchTurnForSession.call(internal, session, session.lastAppliedIntentJson, 'must refuse', {
        runId,
        ensureInteractiveRuntime: true,
      })
    )
    expect({ refusal, effects: counts(), starts: ledger?.startCalls.length }).toEqual({
      refusal: expect.objectContaining({
        code: 'run_mismatch',
        reason: 'app-session-run-id-reused',
      }),
      effects: before,
      starts: 0,
    })
  })

  for (const mode of ['interactive', 'headless'] as const) {
    it(`R-B7(f1) enqueue-delivered cold ${mode}-requested turn keeps the birth grantless`, async () => {
      await bootAspdBirthServer()
      const routes: string[] = []
      const target = internal as any
      const interactiveHandler = target.handleInteractiveTmuxBrokerDispatchTurn.bind(target)
      target.handleInteractiveTmuxBrokerDispatchTurn = async (...args: unknown[]) => {
        routes.push('interactive-tmux-broker')
        return await interactiveHandler(...args)
      }
      const headlessHandler = target.handleHeadlessBrokerDispatchTurn.bind(target)
      target.handleHeadlessBrokerDispatchTurn = async (...args: unknown[]) => {
        routes.push('headless-broker')
        return await headlessHandler(...args)
      }
      const intent = {
        ...baseIntent(),
        harness: {
          provider: 'openai' as const,
          id: mode === 'interactive' ? 'pi-cli' : 'codex-cli',
          interactive: mode === 'interactive',
        },
        execution: { preferredMode: mode },
      } as HrcRuntimeIntent
      seedAppIdentity(intent)
      const runId = `run-t08576-f-${mode}`
      expect(internal.db.runs.getByRunId(runId)).toBeNull()
      const response = await post('/v1/app-sessions/turns', {
        selector: { appId: APP_ID, appSessionKey: KEY },
        prompt: `cold ${mode}`,
        runId,
      })
      expect(response.status).toBe(200)
      await settle(() => (ledger?.startCalls.length ?? 0) === 1)
      const row = internal.db.runs.getByRunId(runId)
      expect(row?.invocationId).toBeDefined()
      const inputId = row?.dispatchedInputId ?? row?.brokerSubmissionId
      expect(inputId).toBeDefined()
      new BrokerEventMapper({ db: internal.db, now: () => NOW }).apply({
        invocationId: row!.invocationId!,
        seq: 2,
        time: NOW,
        type: 'turn.started',
        turnId: `turn-${mode}`,
        inputId: inputId!,
        payload: { turnId: `turn-${mode}`, inputId: inputId! },
      } as InvocationEventEnvelope)
      const runtime = internal.db.runtimes.getByRuntimeId(response.body.runtimeId)
      expect({
        birthCount: ledger?.startCalls.length,
        enqueueCount: ledger?.enqueueCalls.length,
        routes,
        correlation: frozenPreparations(appHost)[0]?.intent?.placement?.correlation,
        env: identityProjection(dispatchedIdentityEnv()),
        targetNamedAtChokepoint: ledger?.startSnapshots[0]?.runIds.includes(runId),
        handleNamedAtChokepoint: ledger?.startSnapshots[0]?.activeRunIds.includes(runId),
        enqueue: ledger?.enqueueCalls[0]?.request,
        row: row && {
          hostSessionId: row.hostSessionId,
          generation: row.generation,
          runtimeId: row.runtimeId,
          operationId: row.operationId,
        },
        runtimeHandle: runtime?.activeRunId,
      }).toEqual({
        birthCount: 1,
        enqueueCount: 1,
        // Both fixture variants currently route through the interactive handler;
        // the label is input intent, never evidence of the selected route.
        routes: ['interactive-tmux-broker'],
        correlation: { hostSessionId: appHost, generation: 1 },
        env: {
          AGENT_HOST_SESSION_ID: appHost,
          HRC_HOST_SESSION_ID: appHost,
          AGENT_GENERATION: '1',
          HRC_GENERATION: '1',
        },
        targetNamedAtChokepoint: false,
        handleNamedAtChokepoint: false,
        enqueue: expect.objectContaining({
          invocationId: String(ledger?.startCalls[0]?.request.spec.invocationId),
          body: `cold ${mode}`,
        }),
        row: {
          hostSessionId: appHost,
          generation: 1,
          runtimeId: response.body.runtimeId,
          operationId: expect.any(String),
        },
        runtimeHandle: runId,
      })
    })
  }

  it('R-B7(g1/g2) initialPrompt birth is granted while promptless ensure is grantless', async () => {
    await bootAspdBirthServer()
    const prompted = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: 'prompted' },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
      initialPrompt: 'grant this start',
    })
    expect(prompted.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)
    const promptedEnv = dispatchedIdentityEnv()
    const promptedRunId = promptedEnv.HRC_RUN_ID
    expect(promptedRunId).toMatch(/^run-/)
    expect(promptedEnv.AGENT_RUN_ID).toBe(promptedRunId)
    const promptedHost = internal.db.appManagedSessions.findByKey(APP_ID, 'prompted')
      ?.activeHostSessionId as string
    const promptedRow = internal.db.runs.getByRunId(promptedRunId)
    const promptedRuntime = internal.db.runtimes.getByRuntimeId(prompted.body.runtimeId)
    expect(promptedRow).toMatchObject({
      hostSessionId: promptedHost,
      generation: 1,
      runtimeId: prompted.body.runtimeId,
      operationId: promptedRuntime?.activeOperationId,
    })
    expect(frozenPreparations(promptedHost)[0]?.intent?.placement?.correlation).toEqual({
      hostSessionId: promptedHost,
      generation: 1,
      runId: promptedRunId,
    })
    expectBirthAutoDispatch({
      hostSessionId: promptedHost,
      runtimeId: prompted.body.runtimeId,
      body: 'grant this start',
    })

    const priorCalls = ledger?.startCalls.length ?? 0
    const promptless = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: 'promptless' },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
    })
    expect(promptless.status).toBe(200)
    await settle(() => (ledger?.startCalls.length ?? 0) === priorCalls + 1)
    const promptlessHost = internal.db.appManagedSessions.findByKey(APP_ID, 'promptless')
      ?.activeHostSessionId as string
    expect({
      birthCount: ledger?.startCalls.length,
      correlation: frozenPreparations(promptlessHost)[0]?.intent?.placement?.correlation,
      env: identityProjection(dispatchedIdentityEnv(priorCalls)),
    }).toEqual({
      birthCount: 2,
      correlation: { hostSessionId: promptlessHost, generation: 1 },
      env: {
        AGENT_HOST_SESSION_ID: promptlessHost,
        HRC_HOST_SESSION_ID: promptlessHost,
        AGENT_GENERATION: '1',
        HRC_GENERATION: '1',
      },
    })
    expectBirthAutoDispatch({
      hostSessionId: promptlessHost,
      runtimeId: promptless.body.runtimeId,
      body: '',
      callIndex: priorCalls,
    })
  })

  it('R-B7(g3) existing live ensure dispatches on the born invocation without another birth', async () => {
    await bootAspdBirthServer()
    const created = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
    })
    expect(created.status).toBe(200)
    const hostSessionId = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
      ?.activeHostSessionId as string
    const bornInvocationId = String(ledger?.startCalls[0]?.request.spec.invocationId)
    const priorRuns = new Set(internal.db.runs.listRuns({ hostSessionId }).map((run) => run.runId))

    const ensured = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
      initialPrompt: 'reuse the live birth',
    })
    expect(ensured.status).toBe(200)
    const newRuns = internal.db.runs
      .listRuns({ hostSessionId })
      .filter((run) => !priorRuns.has(run.runId))

    expect({
      birthCount: ledger?.startCalls.length,
      enqueueCount: ledger?.enqueueCalls.length,
      lastEnqueue: ledger?.enqueueCalls.at(-1)?.request,
      newRuns: newRuns.map((run) => ({
        runId: run.runId,
        hostSessionId: run.hostSessionId,
        generation: run.generation,
        runtimeId: run.runtimeId,
      })),
    }).toEqual({
      birthCount: 1,
      enqueueCount: 2,
      lastEnqueue: expect.objectContaining({
        invocationId: bornInvocationId,
        body: 'reuse the live birth',
      }),
      newRuns: [
        {
          runId: expect.any(String),
          hostSessionId,
          generation: 1,
          runtimeId: created.body.runtimeId,
        },
      ],
    })
  })

  it('R-B7(g4) forceRestart with an initial turn uses a fresh granted id', async () => {
    await bootAspdBirthServer()
    const historicalRunId = 'run-t08576-g4-historical'
    seedAppIdentity(adversarialIntent(historicalRunId))
    seedRun(historicalRunId, 'completed')
    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: adversarialIntent(historicalRunId) },
      forceRestart: true,
      initialPrompt: 'fresh granted restart',
    })
    expect(response.status).toBe(200)
    const env = dispatchedIdentityEnv()
    const runId = env.HRC_RUN_ID
    expect({
      birthCount: ledger?.startCalls.length,
      runId,
      agentRunId: env.AGENT_RUN_ID,
      differsFromHistorical: runId !== historicalRunId,
      correlation: frozenPreparations(appHost)[0]?.intent?.placement?.correlation,
      row: internal.db.runs.getByRunId(runId),
    }).toEqual({
      birthCount: 1,
      runId: expect.stringMatching(/^run-/),
      agentRunId: runId,
      differsFromHistorical: true,
      correlation: { hostSessionId: appHost, generation: 1, runId },
      row: expect.objectContaining({
        hostSessionId: appHost,
        generation: 1,
        runtimeId: response.body.runtimeId,
      }),
    })
  })

  it('R-B7(g5) apply create with an initial turn grants its single birth', async () => {
    await bootAspdBirthServer()
    const intent = { ...baseIntent(), initialPrompt: 'apply-carried initial turn' }
    const response = await post('/v1/app-sessions/apply', {
      appId: APP_ID,
      sessions: [
        { appSessionKey: 'apply-prompted', spec: { kind: 'harness', runtimeIntent: intent } },
      ],
    })
    expect(response.status).toBe(200)
    const hostSessionId = internal.db.appManagedSessions.findByKey(APP_ID, 'apply-prompted')
      ?.activeHostSessionId as string
    const env = dispatchedIdentityEnv()
    const runId = env.HRC_RUN_ID
    const row = internal.db.runs.getByRunId(runId)
    expect({
      birthCount: ledger?.startCalls.length,
      env: identityProjection(env),
      correlation: frozenPreparations(hostSessionId)[0]?.intent?.placement?.correlation,
      row,
    }).toEqual({
      birthCount: 1,
      env: {
        AGENT_HOST_SESSION_ID: hostSessionId,
        HRC_HOST_SESSION_ID: hostSessionId,
        AGENT_RUN_ID: runId,
        HRC_RUN_ID: runId,
        AGENT_GENERATION: '1',
        HRC_GENERATION: '1',
      },
      correlation: { hostSessionId, generation: 1, runId },
      row: expect.objectContaining({ hostSessionId, generation: 1, runtimeId: expect.any(String) }),
    })
  })

  it('R-B7(g6) clear-context relaunch follows the stored initial-turn predicate', async () => {
    await bootAspdBirthServer()
    seedAppIdentity({ ...baseIntent(), initialPrompt: 'stored relaunch turn' })
    const responsePending = post('/v1/app-sessions/clear-context', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      relaunch: true,
    })
    await settle(() => (ledger?.startCalls.length ?? 0) === 1)
    const invocationId = String(ledger?.startCalls[0]?.request.spec.invocationId)
    const birthRun = internal.db.runs
      .listRuns({ limit: 10 })
      .find((run) => run.invocationId === invocationId)
    expect(birthRun).toBeDefined()
    // The shared ASP compile double predates launch-carried route-decision metadata. The real
    // controller persists this marker before broker events arrive; add only that missing fixture
    // fact so the real mapper and wait ledger can settle the already-created HRC run.
    internal.db.runs.setCorrelationJson(
      String(birthRun?.runId),
      launchCarriedInvokeCorrelationJson()
    )
    internal.db.brokerInvocations.update(invocationId, {
      capabilitiesJson: JSON.stringify({ bracketMintingMode: 'harness-evidence' }),
      updatedAt: NOW,
    })
    const mapper = new BrokerEventMapper({ db: internal.db, now: () => NOW })
    mapper.apply({
      invocationId,
      seq: 2,
      time: NOW,
      type: 'turn.started',
      turnId: 'turn-g6',
      payload: { turnId: 'turn-g6', source: 'hook-observed' },
    } as InvocationEventEnvelope)
    mapper.apply({
      invocationId,
      seq: 3,
      time: NOW,
      type: 'submission.executed',
      turnId: 'turn-g6',
      payload: { submissionId: 'submission-g6', turnId: 'turn-g6' },
    } as InvocationEventEnvelope)
    mapper.apply({
      invocationId,
      seq: 4,
      time: NOW,
      type: 'turn.completed',
      turnId: 'turn-g6',
      payload: { turnId: 'turn-g6', status: 'completed' },
    } as InvocationEventEnvelope)
    expect(internal.db.runs.getByRunId(String(birthRun?.runId))?.brokerSubmissionId).toBe(
      'submission-g6'
    )
    const response = await responsePending
    expect(response.status).toBe(200)
    const successor = internal.db.appManagedSessions.findByKey(APP_ID, KEY)
      ?.activeHostSessionId as string
    const env = dispatchedIdentityEnv()
    const runId = env.HRC_RUN_ID
    expect({
      birthCount: ledger?.startCalls.length,
      env: identityProjection(env),
      correlation: frozenPreparations(successor)[0]?.intent?.placement?.correlation,
      row: internal.db.runs.getByRunId(runId),
    }).toEqual({
      birthCount: 1,
      env: {
        AGENT_HOST_SESSION_ID: successor,
        HRC_HOST_SESSION_ID: successor,
        AGENT_RUN_ID: runId,
        HRC_RUN_ID: runId,
        AGENT_GENERATION: '2',
        HRC_GENERATION: '2',
      },
      correlation: { hostSessionId: successor, generation: 2, runId },
      row: expect.objectContaining({ hostSessionId: successor, generation: 2 }),
    })
  })

  it('R-B7(g7) [green-phase grant seam] refuses an ungranted app compile identity before graph writes', async () => {
    const hostSessionId = seedAppIdentity(baseIntent(), 'g7')
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)
    if (session === null) throw new Error('R-B7(g7) fixture session missing')
    const effectsBefore = hostEffectCounts(hostSessionId)
    const identity = await import('../app-session-identity')
    const assertStartGraph = Reflect.get(identity, 'assertAppStartGraphRunIdentity') as
      | ((db: HrcDatabase, target: typeof session, runId: string) => void)
      | undefined
    const refusal = await capturedRefusal(() =>
      assertStartGraph?.(internal.db, session, 'run-t08576-g7-ungranted')
    )
    expect({
      exportPresent: typeof assertStartGraph,
      refusal,
      effects: hostEffectCounts(hostSessionId),
    }).toEqual({
      exportPresent: 'function',
      refusal: {
        code: 'stale_context',
        reason: 'app-birth-run-grant-invalid',
        runId: 'run-t08576-g7-ungranted',
      },
      effects: effectsBefore,
    })
  })
})
