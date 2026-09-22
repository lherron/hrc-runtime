/** T-08576 R-B7(g-t) run-authority acceptance tests. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import { dispatchTurnForSession } from '../turn-dispatch-handlers'
import {
  APP_ID,
  APP_SCOPE,
  KEY,
  NOW,
  appHost,
  armInvocationStartGate,
  baseIntent,
  bootAspdBirthServer,
  commandBinding,
  commandRunId,
  counts,
  dispatchedIdentityEnv,
  launchCalls as fixtureLaunchCalls,
  hostEffectCounts,
  internal,
  ledger,
  post,
  seedAppIdentity,
  seedForeignRuntime,
  seedRun,
  server,
  setUpAppSessionBirthFixture,
  settle,
  tearDownAppSessionBirthFixture,
  writerOutcome,
} from './fixtures/app-session-birth.fixture'

let launchCalls: string[]

async function completeLaunchedRun(runId: string): Promise<void> {
  await settle(() => internal.db.runs.getByRunId(runId)?.invocationId !== undefined)
  const run = internal.db.runs.getByRunId(runId)
  const invocationId = run?.invocationId
  const inputId = run?.dispatchedInputId ?? run?.brokerSubmissionId
  if (invocationId === undefined || inputId === undefined) {
    throw new Error(`R-B7 fixture did not persist launch identity for ${runId}`)
  }
  const mapper = new BrokerEventMapper({ db: internal.db, now: () => NOW })
  const turnId = `turn-${runId}`
  mapper.apply({
    invocationId,
    seq: 2,
    time: NOW,
    type: 'turn.started',
    turnId,
    inputId,
    payload: { turnId, inputId },
  } as InvocationEventEnvelope)
  mapper.apply({
    invocationId,
    seq: 3,
    time: NOW,
    type: 'submission.executed',
    turnId,
    inputId,
    payload: { submissionId: `submission-${runId}`, turnId, inputId },
  } as InvocationEventEnvelope)
  mapper.apply({
    invocationId,
    seq: 4,
    time: NOW,
    type: 'turn.completed',
    turnId,
    inputId,
    payload: { turnId, inputId, status: 'completed' },
  } as InvocationEventEnvelope)
}

beforeEach(async () => {
  await setUpAppSessionBirthFixture()
  launchCalls = fixtureLaunchCalls
})
afterEach(tearDownAppSessionBirthFixture)

describe('T-08576 app-session birth identity boundary', () => {
  it('R-B7(s1-s5) [green-phase ALS seam] carries only a live grant and never authorizes a foreign tuple', async () => {
    const hostSessionId = seedAppIdentity(baseIntent(), 'als')
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)
    if (session === null) throw new Error('R-B7(s) fixture session missing')
    const identity = await import('../app-session-identity')
    const withOwner = Reflect.get(identity, 'withAppIdentityOwner') as
      | ((
          db: HrcDatabase,
          selector: { appId: string; appSessionKey: string },
          run: () => Promise<void>
        ) => Promise<void>)
      | undefined
    const issueGrant = Reflect.get(identity, 'issueAppBirthRunGrant') as
      | ((db: HrcDatabase, target: typeof session, runId: string) => { token: string } | undefined)
      | undefined
    const currentToken = Reflect.get(identity, 'currentAppBirthRunReservationToken') as
      | ((db: HrcDatabase, runId: string) => string | undefined)
      | undefined
    const runId = 'run-t08576-als'
    let token = ''
    let wrongIdToken: string | undefined
    let sealedCallback:
      | (() => { token: string | undefined; write: ReturnType<typeof writerOutcome> })
      | undefined
    let releasedCallback:
      | (() => { token: string | undefined; write: ReturnType<typeof writerOutcome> })
      | undefined
    let beforeSealForeign: ReturnType<typeof writerOutcome> | undefined

    expect({
      withOwner: typeof withOwner,
      issueGrant: typeof issueGrant,
      currentToken: typeof currentToken,
    }).toEqual({
      withOwner: 'function',
      issueGrant: 'function',
      currentToken: 'function',
    })
    await withOwner?.(internal.db, { appId: APP_ID, appSessionKey: 'als' }, async () => {
      token = issueGrant?.(internal.db, session, runId)?.token ?? ''
      wrongIdToken = currentToken?.(internal.db, 'run-t08576-als-other')
      internal.db.runtimes.insert({
        runtimeId: 'rt-t08576-als-bound',
        hostSessionId,
        scopeRef: APP_SCOPE,
        laneRef: 'als',
        generation: 1,
        transport: 'tmux',
        harness: 'pi-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        activeRunId: runId,
        activeOperationId: 'op-t08576-als-bound',
        createdAt: NOW,
        updatedAt: NOW,
      })
      beforeSealForeign = writerOutcome(() =>
        internal.db.runtimes.insert({
          runtimeId: 'rt-t08576-als-before-seal-foreign',
          hostSessionId,
          scopeRef: APP_SCOPE,
          laneRef: 'als',
          generation: 1,
          transport: 'tmux',
          harness: 'pi-cli',
          provider: 'openai',
          status: 'ready',
          supportsInflightInput: false,
          adopted: false,
          activeRunId: runId,
          activeOperationId: 'op-t08576-als-before-seal-foreign',
          createdAt: NOW,
          updatedAt: NOW,
        })
      )
      internal.db.runs.insert({
        runId,
        hostSessionId,
        runtimeId: 'rt-t08576-als-bound',
        operationId: 'op-t08576-als-bound',
        scopeRef: APP_SCOPE,
        laneRef: 'als',
        generation: 1,
        transport: 'tmux',
        status: 'running',
        acceptedAt: NOW,
        startedAt: NOW,
        updatedAt: NOW,
      })
      const foreignWrite = (suffix: string) =>
        writerOutcome(() =>
          internal.db.runtimes.insert({
            runtimeId: `rt-t08576-als-${suffix}`,
            hostSessionId,
            scopeRef: APP_SCOPE,
            laneRef: 'als',
            generation: 1,
            transport: 'tmux',
            harness: 'pi-cli',
            provider: 'openai',
            status: 'ready',
            supportsInflightInput: false,
            adopted: false,
            activeRunId: runId,
            activeOperationId: `op-t08576-als-${suffix}`,
            createdAt: NOW,
            updatedAt: NOW,
          })
        )
      sealedCallback = () => ({
        token: currentToken?.(internal.db, runId),
        write: foreignWrite('sealed'),
      })
      releasedCallback = () => ({
        token: currentToken?.(internal.db, runId),
        write: foreignWrite('released'),
      })
      await Promise.resolve()
      expect(sealedCallback()).toEqual({
        token: undefined,
        write: { threw: true, errorName: 'RunIdOwnershipError' },
      })
    })

    expect({
      tokenIssued: token.length > 0,
      wrongIdToken,
      beforeSealForeign,
      released: releasedCallback?.(),
      outside: currentToken?.(internal.db, runId),
      owner: internal.db.runtimes.getByRuntimeId('rt-t08576-als-bound')?.activeRunId,
    }).toEqual({
      tokenIssued: true,
      wrongIdToken: undefined,
      beforeSealForeign: { threw: true, errorName: 'RunIdOwnershipError' },
      released: { token: undefined, write: { threw: true, errorName: 'RunIdOwnershipError' } },
      outside: undefined,
      owner: runId,
    })
  })

  it('R-B7(r1-r5) [green-phase predicate/log seam] real mapper claims only the persisted birth tuple and preserves refused projections', async () => {
    await bootAspdBirthServer()
    const ensured = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
      initialPrompt: 'mapper-owned birth',
    })
    expect(ensured.status).toBe(200)
    const runId = dispatchedIdentityEnv().HRC_RUN_ID
    const run = internal.db.runs.getByRunId(runId)
    const hostSessionId = String(run?.hostSessionId)
    const runtimeId = String(run?.runtimeId)
    const operationId = String(run?.operationId)
    const invocationId = String(run?.invocationId)
    const logs: Array<{ level: string; event: string; details?: Record<string, unknown> }> = []
    const mapper = new BrokerEventMapper({
      db: internal.db,
      now: () => NOW,
      serverLog: (level, event, details) => logs.push({ level, event, details }),
    })
    const envelope = (targetInvocationId: string, seq: number): InvocationEventEnvelope =>
      ({
        invocationId: targetInvocationId,
        seq,
        time: NOW,
        type: 'turn.started',
        payload: {},
      }) as InvocationEventEnvelope
    const insertInvocation = (
      targetInvocationId: string,
      targetRuntimeId: string,
      targetOperationId: string,
      targetRunId: string
    ) =>
      internal.db.brokerInvocations.insert({
        invocationId: targetInvocationId,
        operationId: targetOperationId,
        runtimeId: targetRuntimeId,
        runId: targetRunId,
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: 'pi-cli',
        invocationState: 'ready',
        capabilitiesJson: '{}',
        specHash: `sha256:${targetInvocationId}:spec`,
        startRequestHash: `sha256:${targetInvocationId}:request`,
        selectedProfileHash: `sha256:${targetInvocationId}:profile`,
        createdAt: NOW,
        updatedAt: NOW,
      })
    const insertAppRuntime = (targetRuntimeId: string, targetOperationId: string) =>
      internal.db.runtimes.insert({
        runtimeId: targetRuntimeId,
        hostSessionId,
        scopeRef: APP_SCOPE,
        laneRef: KEY,
        generation: 1,
        transport: 'tmux',
        harness: 'pi-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        activeOperationId: targetOperationId,
        createdAt: NOW,
        updatedAt: NOW,
      })

    const legitimate = mapper.apply(envelope(invocationId, 2))
    const staleRuntimeId = 'rt-t08576-r-stale'
    const staleOperationId = 'op-t08576-r-stale'
    const staleInvocationId = 'inv-t08576-r-stale'
    insertAppRuntime(staleRuntimeId, staleOperationId)
    insertInvocation(staleInvocationId, staleRuntimeId, staleOperationId, runId)
    const stale = mapper.apply(envelope(staleInvocationId, 1))

    const foreign = seedForeignRuntime({ runtimeId: 'rt-t08576-r-foreign' })
    internal.db.runtimes.update(foreign.runtimeId, {
      activeOperationId: 'op-t08576-r-foreign',
      updatedAt: NOW,
    })
    insertInvocation('inv-t08576-r-foreign', foreign.runtimeId, 'op-t08576-r-foreign', runId)
    const crossHost = mapper.apply(envelope('inv-t08576-r-foreign', 1))

    internal.db.runtimes.updateRunId(runtimeId, undefined, NOW)
    insertInvocation('inv-t08576-r-replay', runtimeId, operationId, runId)
    const replay = mapper.apply(envelope('inv-t08576-r-replay', 1))

    const agentRunId = 'run-t08576-r-agent'
    const agent = seedForeignRuntime({ runtimeId: 'rt-t08576-r-agent' })
    internal.db.runtimes.update(agent.runtimeId, {
      activeOperationId: 'op-t08576-r-agent',
      updatedAt: NOW,
    })
    internal.db.runs.insert({
      runId: agentRunId,
      hostSessionId: agent.hostSessionId,
      runtimeId: agent.runtimeId,
      operationId: 'op-t08576-r-agent',
      scopeRef: agent.scopeRef,
      laneRef: agent.laneRef,
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: NOW,
      updatedAt: NOW,
    })
    insertInvocation('inv-t08576-r-agent', agent.runtimeId, 'op-t08576-r-agent', agentRunId)
    const agentProjection = mapper.apply(envelope('inv-t08576-r-agent', 1))

    expect({
      legitimate: {
        idempotent: legitimate.idempotent,
        runStatus: internal.db.runs.getByRunId(runId)?.status,
      },
      stale: {
        idempotent: stale.idempotent,
        brokerEvent: stale.brokerEvent.type,
        invocationState:
          internal.db.brokerInvocations.getByInvocationId(staleInvocationId)?.invocationState,
        activeRunId: internal.db.runtimes.getByRuntimeId(staleRuntimeId)?.activeRunId,
      },
      crossHost: {
        idempotent: crossHost.idempotent,
        brokerEvent: crossHost.brokerEvent.type,
        activeRunId: internal.db.runtimes.getByRuntimeId(foreign.runtimeId)?.activeRunId,
      },
      replay: {
        idempotent: replay.idempotent,
        activeRunId: internal.db.runtimes.getByRuntimeId(runtimeId)?.activeRunId,
      },
      agent: {
        idempotent: agentProjection.idempotent,
        activeRunId: internal.db.runtimes.getByRuntimeId(agent.runtimeId)?.activeRunId,
      },
      refusedLogs: logs
        .filter((entry) => entry.event === 'broker.run_handle_refused')
        .map((entry) => entry.details?.runtimeId),
    }).toEqual({
      legitimate: { idempotent: false, runStatus: 'running' },
      stale: {
        idempotent: false,
        brokerEvent: 'turn.started',
        invocationState: 'turn_active',
        activeRunId: undefined,
      },
      crossHost: {
        idempotent: false,
        brokerEvent: 'turn.started',
        activeRunId: undefined,
      },
      replay: { idempotent: false, activeRunId: runId },
      agent: { idempotent: false, activeRunId: agentRunId },
      refusedLogs: [staleRuntimeId, foreign.runtimeId],
    })
  })

  it('R-B7(i) concurrent app selectors cannot both dispatch the same caller run id', async () => {
    await bootAspdBirthServer()
    const oneHost = seedAppIdentity(baseIntent(), 'one')
    const twoHost = seedAppIdentity(baseIntent(), 'two')
    const twoEffectsBefore = hostEffectCounts(twoHost)
    const runId = 'run-t08576-concurrent'
    const gate = armInvocationStartGate()
    const oneTurn = post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: 'one' },
      prompt: 'one',
      runId,
    })
    const firstRace = await Promise.race([
      gate.reached.then(() => 'birth-reached' as const),
      oneTurn.then(() => 'first-settled' as const),
    ])
    let twoSettled = false
    const twoTurn = post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: 'two' },
      prompt: 'two',
      runId,
    }).finally(() => {
      twoSettled = true
    })
    await Bun.sleep(20)
    const loserSettledBeforeWinnerRelease = twoSettled
    gate.signalRelease()
    await completeLaunchedRun(runId)
    const [one, two] = await Promise.all([oneTurn, twoTurn])

    const outcomes = [
      { key: 'one', hostSessionId: oneHost, response: one },
      { key: 'two', hostSessionId: twoHost, response: two },
    ]
    const winner = outcomes.find(({ response }) => response.status === 200)
    const loser = outcomes.find(({ response }) => response.status === 409)
    const runRows = internal.db.sqlite
      .query<{ host_session_id: string; generation: number }, [string]>(
        'SELECT host_session_id, generation FROM runs WHERE run_id = ?'
      )
      .all(runId)
    const handles = internal.db.sqlite
      .query<{ host_session_id: string; generation: number }, [string]>(
        'SELECT host_session_id, generation FROM runtimes WHERE active_run_id = ? ORDER BY runtime_id'
      )
      .all(runId)

    expect({
      firstRace,
      loserSettledBeforeWinnerRelease,
      statuses: outcomes.map(({ response }) => response.status).sort((a, b) => a - b),
      loserCode: loser?.response.body.error?.code,
      loserReason: loser?.response.body.error?.detail?.reason,
      loserHost: loser?.hostSessionId,
      aspdStarts: ledger?.startCalls.length,
      runRows,
      runOwnedByWinner:
        runRows.length === 1 &&
        runRows[0]?.host_session_id === winner?.hostSessionId &&
        runRows[0]?.generation ===
          internal.db.sessions.getByHostSessionId(winner?.hostSessionId ?? '')?.generation,
      winnerHost: winner?.hostSessionId,
      winnerGeneration: winner
        ? internal.db.sessions.getByHostSessionId(winner.hostSessionId)?.generation
        : undefined,
      handles,
      allHandlesBelongToWinner: handles.every(
        (handle) =>
          handle.host_session_id === winner?.hostSessionId &&
          handle.generation ===
            internal.db.sessions.getByHostSessionId(winner?.hostSessionId ?? '')?.generation
      ),
      loserEffects: hostEffectCounts(twoHost),
    }).toEqual({
      firstRace: 'birth-reached',
      loserSettledBeforeWinnerRelease: true,
      statuses: [200, 409],
      loserCode: 'run_mismatch',
      loserReason: 'app-session-run-id-reused',
      loserHost: twoHost,
      aspdStarts: 1,
      runRows: [{ host_session_id: oneHost, generation: 1 }],
      runOwnedByWinner: true,
      winnerHost: oneHost,
      winnerGeneration: 1,
      handles: expect.any(Array),
      allHandlesBelongToWinner: true,
      loserEffects: twoEffectsBefore,
    })
  })

  it('R-B7(j) broker reuse performs no birth and the later persisted id is refused', async () => {
    seedAppIdentity()
    internal.db.runtimes.insert({
      runtimeId: 'rt-t08576-reuse',
      hostSessionId: appHost,
      scopeRef: APP_SCOPE,
      laneRef: KEY,
      generation: 1,
      transport: 'headless',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const runId = 'run-t08576-reuse'
    const first = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'reuse live broker',
      runId,
    })
    expect(first.status).toBe(200)
    expect(launchCalls).toEqual([`${appHost}:${runId}`])
    seedRun(runId, 'completed')
    launchCalls = []
    const second = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must now refuse',
      runId,
    })
    expect(second).toMatchObject({
      status: 409,
      body: { error: { code: 'run_mismatch', detail: { reason: 'app-session-run-id-reused' } } },
    })
    expect(launchCalls).toEqual([])
  })

  it('R-B7(k) agent pre-accepted run admission stays unchanged', async () => {
    const hostSessionId = `hsid-${randomUUID()}`
    const scopeRef = 'agent:smokey:project:hrc-runtime:task:T-08576'
    internal.db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef: 'agent-control',
      generation: 1,
      status: 'active',
      lastAppliedIntentJson: {
        ...baseIntent(),
        harness: { provider: 'anthropic', id: 'claude-code', interactive: false },
        execution: { preferredMode: 'headless' },
      },
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
    const runId = 'run-t08576-agent-preaccepted'
    internal.db.runs.insert({
      runId,
      hostSessionId,
      scopeRef,
      laneRef: 'agent-control',
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: NOW,
      updatedAt: NOW,
    })
    internal.db.runtimes.insert({
      runtimeId: 'rt-t08576-agent-control',
      hostSessionId,
      scopeRef,
      laneRef: 'agent-control',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
    ;(internal as unknown as Record<string, unknown>).executeHeadlessBrokerInputTurn = async () =>
      Response.json({ runId, hostSessionId, runtimeId: 'rt-t08576-agent-control' })
    ;(internal as unknown as Record<string, unknown>).startHeadlessBrokerRuntime = async () =>
      internal.db.runtimes.getByRuntimeId('rt-t08576-agent-control')
    ;(internal as unknown as Record<string, unknown>).startInteractiveTmuxBrokerRuntime =
      async () => internal.db.runtimes.getByRuntimeId('rt-t08576-agent-control')
    ;(internal as unknown as Record<string, unknown>).executeInteractiveBrokerInputTurn =
      async () => Response.json({ runId, hostSessionId, runtimeId: 'rt-t08576-agent-control' })
    ;(internal as unknown as Record<string, unknown>).handleHeadlessBrokerDispatchTurn = async () =>
      Response.json({ runId, hostSessionId, runtimeId: 'rt-t08576-agent-control' })
    const headlessIntent = {
      ...baseIntent(),
      harness: { provider: 'anthropic' as const, id: 'claude-code', interactive: false },
      execution: { preferredMode: 'headless' as const },
    }
    const response = await dispatchTurnForSession.call(
      internal,
      internal.db.sessions.getByHostSessionId(hostSessionId)!,
      headlessIntent,
      'agent control',
      { runId, ensureInteractiveRuntime: true }
    )
    expect(response.status).toBe(200)
    expect(internal.db.runs.getByRunId(runId)?.hostSessionId).toBe(hostSessionId)
  })

  it('R-B7(m) command replay returns the already-persisted app run with zero command effects', async () => {
    await bootAspdBirthServer()
    seedAppIdentity()
    const idempotencyKey = 't08576-command-crossing-m'
    const runId = commandRunId(idempotencyKey)
    const gate = armInvocationStartGate()
    const appTurn = post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'hold app birth',
      runId,
    })
    const first = await Promise.race([
      gate.reached.then(() => 'birth-reached' as const),
      appTurn.then((response) => ({ response })),
    ])
    expect(first).toBe('birth-reached')
    const beforeCommand = counts()
    const appRunBeforeCommand = internal.db.runs.getByRunId(runId)
    expect(appRunBeforeCommand).toMatchObject({
      hostSessionId: appHost,
      generation: 1,
      runtimeId: expect.any(String),
      operationId: expect.any(String),
    })
    const commandSessionRef = 'agent:smokey:project:hrc-runtime:task:T-08576/lane:command-m'
    const command = await post('/v1/command-runs/launch', {
      configuredTargetId: 't08576',
      idempotencyKey,
      sessionRef: commandSessionRef,
      binding: commandBinding(commandSessionRef, 'command-m'),
    })
    const commandEffects = counts()
    gate.signalRelease()
    await completeLaunchedRun(runId)
    const appResponse = await appTurn
    const winner = internal.db.runs.getByRunId(runId)
    const winnerOwnership = winner && {
      hostSessionId: winner.hostSessionId,
      generation: winner.generation,
      runtimeId: winner.runtimeId,
      operationId: winner.operationId,
    }
    expect({ command, effects: commandEffects, winnerOwnership }).toEqual({
      command: {
        status: 200,
        body: {
          runId,
          hostSessionId: appHost,
          runtimeId: appRunBeforeCommand?.runtimeId,
          generation: 1,
          transport: 'headless',
          replayed: true,
        },
      },
      effects: beforeCommand,
      winnerOwnership: {
        hostSessionId: appHost,
        generation: 1,
        runtimeId: appRunBeforeCommand?.runtimeId,
        operationId: appRunBeforeCommand?.operationId,
      },
    })

    expect(appResponse.status).toBe(200)
    expect(winner).toMatchObject({
      hostSessionId: appHost,
      generation: 1,
      runtimeId: expect.any(String),
      operationId: expect.any(String),
    })
    expect(
      internal.db.sqlite
        .query<{ count: number }, [string, string]>(
          'SELECT COUNT(*) AS count FROM runtimes WHERE active_run_id = ? AND host_session_id <> ?'
        )
        .get(runId, appHost)?.count
    ).toBe(0)
  })

  it('R-B7(n1) an existing command runtime handle blocks app reservation before app effects', async () => {
    seedAppIdentity()
    const commandHost = `hsid-${randomUUID()}`
    const commandScope = 'agent:smokey:project:hrc-runtime:task:T-08576'
    const runId = commandRunId('t08576-command-crossing-n1')
    internal.db.sessions.insert({
      hostSessionId: commandHost,
      scopeRef: commandScope,
      laneRef: 'command-n1',
      generation: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
    internal.db.runtimes.insert({
      runtimeId: 'rt-t08576-command-n1',
      runtimeKind: 'command',
      hostSessionId: commandHost,
      scopeRef: commandScope,
      laneRef: 'command-n1',
      generation: 1,
      transport: 'tmux',
      harness: 'custom',
      provider: 'custom',
      status: 'busy',
      commandSpec: { launchMode: 'exec', argv: ['/bin/true'] },
      supportsInflightInput: false,
      adopted: false,
      activeRunId: runId,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const before = counts()
    const response = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must see command handle',
      runId,
    })
    expect({ response, effects: counts(), launches: launchCalls }).toEqual({
      response: {
        status: 409,
        body: {
          error: expect.objectContaining({
            code: 'run_mismatch',
            detail: expect.objectContaining({ reason: 'app-session-run-id-reused', runId }),
          }),
        },
      },
      effects: before,
      launches: [],
    })
    internal.db.runs.insert({
      runId,
      hostSessionId: commandHost,
      runtimeId: 'rt-t08576-command-n1',
      scopeRef: commandScope,
      laneRef: 'command-n1',
      generation: 1,
      transport: 'tmux',
      status: 'completed',
      acceptedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    })
    expect(internal.db.runs.getByRunId(runId)?.hostSessionId).toBe(commandHost)
  })

  it('R-B7(n2/n3) command precheck first cannot rewrite the persisted app run handle', async () => {
    await bootAspdBirthServer()
    seedAppIdentity()
    const idempotencyKey = 't08576-command-crossing-n2'
    const runId = commandRunId(idempotencyKey)
    const target = server as unknown as {
      resolveOrCreateCommandRunSession(sessionRef: string): Promise<unknown>
    }
    const resolveCommandSession = target.resolveOrCreateCommandRunSession.bind(target)
    let signalCommandResolved!: () => void
    let signalResumeCommand!: () => void
    const commandResolved = new Promise<void>((resolve) => {
      signalCommandResolved = resolve
    })
    const resumeCommand = new Promise<void>((resolve) => {
      signalResumeCommand = resolve
    })
    target.resolveOrCreateCommandRunSession = async (sessionRef: string) => {
      const session = await resolveCommandSession(sessionRef)
      signalCommandResolved()
      await resumeCommand
      return session
    }
    const commandSessionRef = 'agent:smokey:project:hrc-runtime:task:T-08576/lane:command-n2'
    const commandRun = post('/v1/command-runs/launch', {
      configuredTargetId: 't08576',
      idempotencyKey,
      sessionRef: commandSessionRef,
      binding: commandBinding(commandSessionRef, 'command-n2'),
    })
    const commandFirst = await Promise.race([
      commandResolved.then(() => 'command-resolved' as const),
      commandRun.then((response) => ({ response })),
    ])
    expect(commandFirst).toBe('command-resolved')
    const commandPrecheckEffects = counts()

    const birthGate = armInvocationStartGate()
    const appTurn = post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'reserve while command waits',
      runId,
    })
    const first = await Promise.race([
      birthGate.reached.then(() => 'birth-reached' as const),
      appTurn.then((response) => ({ response })),
    ])
    if (first !== 'birth-reached') signalResumeCommand()
    expect(first).toBe('birth-reached')
    const appRunBeforeCommandResume = internal.db.runs.getByRunId(runId)
    expect(appRunBeforeCommandResume).toMatchObject({
      hostSessionId: appHost,
      generation: 1,
      runtimeId: expect.any(String),
      operationId: expect.any(String),
    })

    signalResumeCommand()
    const command = await commandRun
    birthGate.signalRelease()
    await completeLaunchedRun(runId)
    const appResponse = await appTurn
    const appRunAfterCommandResume = internal.db.runs.getByRunId(runId)
    const appRunOwnershipAfterCommandResume = appRunAfterCommandResume && {
      hostSessionId: appRunAfterCommandResume.hostSessionId,
      generation: appRunAfterCommandResume.generation,
      runtimeId: appRunAfterCommandResume.runtimeId,
      operationId: appRunAfterCommandResume.operationId,
    }
    const commandWrites = {
      runtimes: internal.db.sqlite
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM runtimes WHERE lane_ref = ?'
        )
        .get('command-n2')?.count,
      runs: internal.db.sqlite
        .query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM runs WHERE lane_ref = ?')
        .get('command-n2')?.count,
    }
    expect(command).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'run_mismatch',
          detail: { reason: 'run-id-not-owned', refusal: 'runtime-mismatch', runId },
        },
      },
    })
    expect(appRunOwnershipAfterCommandResume).toEqual({
      hostSessionId: appHost,
      generation: 1,
      runtimeId: appRunBeforeCommandResume?.runtimeId,
      operationId: appRunBeforeCommandResume?.operationId,
    })
    expect(commandWrites).toEqual({ runtimes: 0, runs: 0 })
    expect({
      runtimes: commandPrecheckEffects.runtimes,
      runs: commandPrecheckEffects.runs,
    }).toEqual({
      runtimes: 0,
      runs: 0,
    })
    expect(
      internal.db.sqlite
        .query<{ count: number }, [string, string]>(
          'SELECT COUNT(*) AS count FROM runtimes WHERE active_run_id = ? AND host_session_id <> ?'
        )
        .get(runId, appHost)?.count
    ).toBe(0)

    expect(appResponse.status).toBe(200)
    const handleHosts = internal.db.sqlite
      .query<{ host_session_id: string }, [string]>(
        'SELECT host_session_id FROM runtimes WHERE active_run_id = ? ORDER BY host_session_id'
      )
      .all(runId)
      .map(({ host_session_id }) => host_session_id)
    expect(handleHosts.every((host) => host === appHost)).toBe(true)
    expect(internal.db.runs.getByRunId(runId)).toMatchObject({
      hostSessionId: appHost,
      generation: 1,
      runtimeId: expect.any(String),
      operationId: expect.any(String),
    })
  })

  it('R-B7(o) refuses a completed command-run id owned by a foreign agent host', async () => {
    seedAppIdentity()
    const foreignHost = `hsid-${randomUUID()}`
    internal.db.sessions.insert({
      hostSessionId: foreignHost,
      scopeRef: 'agent:foreign:project:hrc-runtime',
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
    const runId = 'run-command-t08576-existing'
    seedRun(runId, 'completed', foreignHost)
    const before = counts()
    const response = await post('/v1/app-sessions/turns', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      prompt: 'must not claim command id',
      runId,
    })

    expect({
      status: response.status,
      reason: response.body.error?.detail?.reason,
      effects: counts(),
    }).toEqual({
      status: 409,
      reason: 'app-session-run-id-reused',
      effects: before,
    })
    expect(launchCalls).toEqual([])
  })

  it('R-B7(q) controls allow own-host app and ordinary agent run handles', () => {
    seedAppIdentity()
    const appRunId = 'run-t08576-own-host-control'
    const appRuntimeId = 'rt-t08576-own-host-control'
    const appOperationId = 'op-t08576-own-host-control'
    internal.db.runtimes.insert({
      runtimeId: appRuntimeId,
      hostSessionId: appHost,
      scopeRef: APP_SCOPE,
      laneRef: KEY,
      generation: 1,
      transport: 'headless',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      activeOperationId: appOperationId,
      createdAt: NOW,
      updatedAt: NOW,
    })
    internal.db.runs.insert({
      runId: appRunId,
      hostSessionId: appHost,
      runtimeId: appRuntimeId,
      operationId: appOperationId,
      scopeRef: APP_SCOPE,
      laneRef: KEY,
      generation: 1,
      transport: 'headless',
      status: 'running',
      acceptedAt: NOW,
      startedAt: NOW,
      updatedAt: NOW,
    })
    internal.db.runtimes.updateRunId(appRuntimeId, appRunId, NOW)
    const differentRuntime = writerOutcome(() =>
      internal.db.runtimes.insert({
        runtimeId: 'rt-t08576-own-host-different-runtime',
        hostSessionId: appHost,
        scopeRef: APP_SCOPE,
        laneRef: KEY,
        generation: 1,
        transport: 'headless',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        activeRunId: appRunId,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    const agentRuntime = seedForeignRuntime({
      runtimeId: 'rt-t08576-agent-control-q',
      laneRef: 'agent-control-q',
    })
    const agentRunId = 'run-t08576-agent-control-q'
    internal.db.runs.insert({
      runId: agentRunId,
      hostSessionId: agentRuntime.hostSessionId,
      scopeRef: agentRuntime.scopeRef,
      laneRef: agentRuntime.laneRef,
      generation: 1,
      transport: 'headless',
      status: 'running',
      acceptedAt: NOW,
      startedAt: NOW,
      updatedAt: NOW,
    })
    internal.db.runtimes.updateRunId(agentRuntime.runtimeId, agentRunId, NOW)

    expect({
      appHandle: internal.db.runtimes.getByRuntimeId(appRuntimeId)?.activeRunId,
      appRunStatus: internal.db.runs.getByRunId(appRunId)?.status,
      differentRuntime,
      differentRuntimePersisted: internal.db.runtimes.getByRuntimeId(
        'rt-t08576-own-host-different-runtime'
      ),
      agentHandle: internal.db.runtimes.getByRuntimeId(agentRuntime.runtimeId)?.activeRunId,
      agentRunStatus: internal.db.runs.getByRunId(agentRunId)?.status,
    }).toEqual({
      appHandle: appRunId,
      appRunStatus: 'running',
      differentRuntime: { threw: true, errorName: 'RunIdOwnershipError' },
      differentRuntimePersisted: null,
      agentHandle: agentRunId,
      agentRunStatus: 'running',
    })
  })
})
