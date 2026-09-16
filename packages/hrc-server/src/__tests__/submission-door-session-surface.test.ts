import { Database } from 'bun:sqlite'
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
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

// A projection double: it stands in for dispatch so the door's request plumbing
// and response projection can be asserted without a broker. It decides NO
// admission — ownership-proof refusal is exercised on the real handler path in
// the T-08540 block below, because a double that invented its own refusal let
// this file pass while live admitted a forged proof.
function installDispatchDouble(): void {
  internal.dispatchTurnForSession = async (session, intent, prompt, options) => {
    captures.push({
      hostSessionId: session.hostSessionId,
      intent,
      prompt,
      ...(options.establishedBrokerInvocationId !== undefined
        ? { establishedBrokerInvocationId: options.establishedBrokerInvocationId }
        : {}),
    })
    const rejected = prompt === 'busy'
    return Response.json({
      submissionId: rejected ? 'sub-rejected' : 'sub-admitted',
      admission: rejected ? 'rejected' : 'admitted',
      ...(rejected ? { reason: 'busy' } : {}),
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
}

function doorBody(establishedBrokerInvocationId = 'inv-established', body = 'ship it') {
  return {
    target: hostSessionId,
    body,
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
  beforeEach(() => {
    installDispatchDouble()
  })

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
    const response = await fixture.postJson(
      '/v1/submissions/invoke',
      doorBody('inv-established', 'busy')
    )
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toEqual({
      submissionId: 'sub-rejected',
      admission: 'rejected',
      reason: 'busy',
      disposition: {
        type: 'rejected',
        reason: 'busy',
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
})

describe('T-08540 ownership proof is decided by the real admission on every door', () => {
  const ACTIVE_INVOCATION = 'inv-t08540-active'
  const RUNTIME_ID = 'rt-t08540-live-codex'
  let delivered: Array<{ runtimeId: string; runId: string; prompt: string }>

  // Only the seams BELOW the admission decision are replaced: the tmux liveness
  // probe (no real pane), presentation, and broker input delivery (no real
  // broker). dispatchTurnForSession and decideInteractiveBrokerAdmission run
  // for real, so this cannot pass while the live door admits a forged proof.
  beforeEach(() => {
    delivered = []
    const timestamp = fixture.now()
    const session = internal.db.sessions.getByHostSessionId(hostSessionId)
    if (!session) throw new Error('fixture session missing')
    internal.db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      controllerKind: 'harness-broker',
      activeInvocationId: ACTIVE_INVOCATION,
      tmuxJson: {
        socketPath: fixture.tmuxSocketPath,
        sessionName: 'hrc-t08540',
        windowName: 'main',
        paneId: '%t08540',
        brokerDriver: 'codex-cli-tmux',
      },
      supportsInflightInput: true,
      adopted: false,
      lastActivityAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    internal.reconcileTmuxRuntimeLiveness = async (runtime) => runtime
    internal.publishPresentation = async () => undefined
    internal.handleInteractiveTmuxBrokerDispatchTurn = async () => {
      throw new Error('T-08540: admission must not start or reprovision a broker')
    }
    internal.executeInteractiveBrokerInputTurn = async (
      submittedSession,
      runtime,
      prompt,
      runId
    ) => {
      delivered.push({ runtimeId: runtime.runtimeId, runId, prompt })
      return Response.json({
        submissionId: `sub-${runId}`,
        admission: 'admitted',
        startIdentity: { kind: 'broker', invocationId: ACTIVE_INVOCATION },
        runId,
        hostSessionId: submittedSession.hostSessionId,
        generation: submittedSession.generation,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        status: 'started',
        supportsInFlightInput: true,
      })
    }
  })

  function liveIntent(refuseReuse: boolean): HrcRuntimeIntent {
    return {
      placement: runtimeIntent.placement,
      harness: { provider: 'openai', id: 'codex-cli', interactive: true },
      execution: {
        preferredMode: 'interactive',
        ...(refuseReuse ? { allowInteractiveSurfaceReuse: false } : {}),
      },
    }
  }

  function post(door: 'invoke' | 'turns', proof: string, refuseReuse: boolean) {
    const intent = liveIntent(refuseReuse)
    return door === 'invoke'
      ? fixture.postJson('/v1/submissions/invoke', {
          ...doorBody(proof),
          runtimeIntent: intent,
        })
      : fixture.postJson('/v1/turns', { ...turnsBody(proof), runtimeIntent: intent })
  }

  function runsOnSession(): number {
    const db = new Database(fixture.dbPath, { readonly: true })
    try {
      const row = db
        .query('SELECT count(*) AS n FROM runs WHERE host_session_id = ?')
        .get(hostSessionId) as { n: number }
      return row.n
    } finally {
      db.close()
    }
  }

  for (const door of ['invoke', 'turns'] as const) {
    for (const refuseReuse of [false, true]) {
      const flag = refuseReuse ? 'allowInteractiveSurfaceReuse:false' : 'reuse flag absent'
      it(`${door}: a forged proof is refused with caller-surface-reuse-refusal (${flag})`, async () => {
        const runsBefore = runsOnSession()
        const response = await post(door, 'inv-forged-t08540', refuseReuse)
        const body = (await response.json()) as Record<string, unknown>

        expect(response.status).toBe(503)
        expect(body).toMatchObject({
          error: {
            code: 'runtime_unavailable',
            message: 'caller-surface-reuse-refusal',
            detail: { route: 'interactive-broker', reason: 'caller-surface-reuse-refusal' },
          },
        })
        expect(delivered).toHaveLength(0)
        expect(runsOnSession()).toBe(runsBefore)
        const runtime = internal.db.runtimes.getByRuntimeId(RUNTIME_ID)
        expect(runtime?.status).toBe('ready')
        expect(runtime?.activeInvocationId).toBe(ACTIVE_INVOCATION)
      })

      it(`${door}: the seat's own active invocation is admitted into the live surface (${flag})`, async () => {
        const response = await post(door, ACTIVE_INVOCATION, refuseReuse)
        const body = (await response.json()) as Record<string, unknown>

        expect(response.status).toBe(202)
        expect(body).toMatchObject({ admission: 'admitted', runtimeId: RUNTIME_ID })
        expect(delivered).toHaveLength(1)
        expect(delivered[0]).toMatchObject({ runtimeId: RUNTIME_ID, prompt: 'ship it' })
      })
    }

    it(`${door}: no proof and no refusal flag still reuses the live surface`, async () => {
      const intent = liveIntent(false)
      const { establishedBrokerInvocationId: _proof, ...invoke } = doorBody()
      const { establishedBrokerInvocationId: _turnsProof, ...turns } = turnsBody()
      const response =
        door === 'invoke'
          ? await fixture.postJson('/v1/submissions/invoke', { ...invoke, runtimeIntent: intent })
          : await fixture.postJson('/v1/turns', { ...turns, runtimeIntent: intent })

      expect(response.status).toBe(202)
      expect(delivered).toHaveLength(1)
    })
  }

  for (const door of ['enqueue', 'preempt'] as const) {
    it(`${door}: a forged proof on an idle live seat is refused, not delivered`, async () => {
      const runsBefore = runsOnSession()
      // Preempt authority is granted to an operator so the request reaches
      // admission; an agent without a turn in flight is authority-denied first.
      const response = await fixture.postJson(`/v1/submissions/${door}`, {
        ...doorBody('inv-forged-t08540'),
        ...(door === 'preempt' ? { origin: { principalRef: 'human:lance' } } : {}),
        runtimeIntent: liveIntent(false),
      })
      const body = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(503)
      expect(body).toMatchObject({
        error: { code: 'runtime_unavailable', message: 'caller-surface-reuse-refusal' },
      })
      expect(delivered).toHaveLength(0)
      expect(runsOnSession()).toBe(runsBefore)
    })
  }

  it('forged-proof refusal is identical through /v1/turns and the invoke door', async () => {
    const invoke = await post('invoke', 'inv-forged-t08540', false)
    const turns = await post('turns', 'inv-forged-t08540', false)

    expect(turns.status).toBe(invoke.status)
    expect(await turns.json()).toEqual(await invoke.json())
  })
})
