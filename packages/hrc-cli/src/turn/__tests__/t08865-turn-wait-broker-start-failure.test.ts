/**
 * T-08865 — `hrc turn --wait final` must end when the admitted turn fails, and
 * `--timeout` must bound every wait door whatever the server does.
 *
 * The daemon here is a real unix-socket HTTP server driven through the real
 * HrcClient. Its event stream replays the ledger rows HRC wrote on max3 for
 * piper@agent-spaces:smoke-pr5-0924 (2026-09-24, broker start failed with
 * `OAuth mode requires dispatchEnv.HARNESS_PI_AUTH_STORE`), captured verbatim
 * from `GET /v1/events`, then holds the follow stream open like the live daemon.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HrcLifecycleEvent } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import type { TurnCommandDependencies } from '../commands/turn.js'
import { makeHandoff, runTurnCommand } from './turn-test-harness'

const SCOPE = 'agent:piper:project:agent-spaces:task:smoke-pr5-0924'
const RUN = 'run-04b81ca4-9c0e-4bb0-ab6a-8c4d3d7f0a81'
const RUNTIME = 'rt-454adaed-81bf-47dd-8bfe-c3ed43416356'
const HSID = 'hsid-0511fc83-9c2a-4142-8dc4-c68017b37a86'

const base = {
  hostSessionId: HSID,
  scopeRef: SCOPE,
  laneRef: 'main',
  generation: 1,
  runtimeId: RUNTIME,
  runId: RUN,
  replayed: false,
}

const TURN_ACCEPTED = {
  ...base,
  hrcSeq: 2296949,
  streamSeq: 16561899,
  ts: '2026-09-24T08:39:28.908Z',
  category: 'turn',
  eventKind: 'turn.accepted',
  transport: 'headless',
  payload: { promptLength: 197, authority: 'durable-start-graph' },
} as HrcLifecycleEvent

const TURN_FAILED = {
  ...base,
  hrcSeq: 2296969,
  streamSeq: 16561919,
  ts: '2026-09-24T08:39:36.907Z',
  category: 'turn',
  eventKind: 'turn.failed',
  transport: 'headless',
  errorCode: 'runtime_unavailable',
  payload: {
    code: 'broker_start_failed',
    message: 'OAuth mode requires dispatchEnv.HARNESS_PI_AUTH_STORE',
    phase: 'broker-invocation-start',
  },
} as HrcLifecycleEvent

const FIRST_TURN_MISSING = {
  ...base,
  hrcSeq: 2296972,
  streamSeq: 16561922,
  ts: '2026-09-24T08:41:39.663Z',
  category: 'runtime',
  eventKind: 'first_turn_missing',
  errorCode: 'first_turn_missing',
  payload: {
    runtimeId: RUNTIME,
    generation: 1,
    scopeRef: SCOPE,
    hostSessionId: HSID,
    runId: RUN,
    invocationId: 'inv-9ab2a9ff-826b-46c6-a569-36656b9ad845',
    primingDispatchedAt: '2026-09-24T08:39:28.905Z',
    firstTurnDeadlineAt: '2026-09-24T08:41:28.905Z',
    trippedAt: '2026-09-24T08:41:39.663Z',
  },
} as HrcLifecycleEvent

type DaemonScript = {
  sessionFound: boolean
  events: HrcLifecycleEvent[]
  /** The steer door never answers: a server-side wait that does not end. */
  steerHangs?: boolean
  /** The steer door's waited response body. */
  steerResponse?: Record<string, unknown>
}

const daemons: Array<{ stop: () => void }> = []
afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.stop()
})

function startDaemon(script: DaemonScript): string {
  const socketPath = join(mkdtempSync(join(tmpdir(), 't08865-')), 'hrc.sock')
  const held: Array<ReadableStreamDefaultController<Uint8Array>> = []
  const server = Bun.serve({
    unix: socketPath,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/v1/sessions/resolve') {
        return Response.json(
          script.sessionFound
            ? { found: true, hostSessionId: HSID, generation: 1, created: false }
            : { found: false, hostSessionId: null, generation: null, created: false, session: null }
        )
      }
      if (url.pathname === '/v1/messages/turn-handoff') {
        return Response.json(
          makeHandoff({
            sessionRef: `${SCOPE}/lane:main`,
            scopeRef: SCOPE,
            laneRef: 'main',
            hostSessionId: HSID,
            runtimeId: RUNTIME,
            runId: RUN,
            generation: 1,
            fromSeq: 2296948,
          })
        )
      }
      if (url.pathname === '/v1/submissions/steer') {
        // Never resolves; the client's own deadline must end the wait.
        if (script.steerHangs) return await new Promise<Response>(() => {})
        if (script.steerResponse) return Response.json(script.steerResponse)
      }
      if (url.pathname === '/v1/events') {
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const event of script.events) {
                controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
              }
              // follow=true: the live daemon keeps the stream open.
              held.push(controller)
            },
          }),
          { headers: { 'content-type': 'application/x-ndjson' } }
        )
      }
      return Response.json({ error: { code: 'unknown', message: url.pathname } }, { status: 404 })
    },
  })
  daemons.push({ stop: () => server.stop(true) })
  return socketPath
}

const launchTarget: TurnCommandDependencies = {
  async resolveLaunchTarget() {
    return {
      resolved: {
        scopeRef: SCOPE,
        laneRef: 'main',
        laneId: 'main',
        parsed: { agentId: 'piper', projectId: 'agent-spaces', taskId: 'smoke-pr5-0924' },
      },
      sessionRef: `${SCOPE}/lane:main`,
      runtimeIntent: {},
    } as never
  },
}

async function timedTurn(socketPath: string, timeout: string) {
  const startedAt = Date.now()
  const result = await runTurnCommand(
    new HrcClient(socketPath),
    { wait: 'final', timeout, format: 'ndjson' },
    ['piper@agent-spaces:smoke-pr5-0924', 'Smoke test. Reply with exactly: PONG-piper'],
    launchTarget
  )
  return { ...result, elapsedMs: Date.now() - startedAt }
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('T-08865 hrc turn --wait on a failed turn', () => {
  it('returns non-zero promptly on turn.failed and names the failure code', async () => {
    const socket = startDaemon({ sessionFound: false, events: [TURN_ACCEPTED, TURN_FAILED] })
    const result = await timedTurn(socket, '8m')

    expect(result.error).toBeUndefined()
    expect(result.exitCode).not.toBe(0)
    expect(result.elapsedMs).toBeLessThan(5_000)
    const failure = jsonLines(result.stdout).find((line) => line['result'] === 'turn_failed')
    expect(failure).toMatchObject({
      result: 'turn_failed',
      runId: RUN,
      eventKind: 'turn.failed',
      hrcSeq: 2296969,
      errorCode: 'runtime_unavailable',
      code: 'broker_start_failed',
      message: 'OAuth mode requires dispatchEnv.HARNESS_PI_AUTH_STORE',
    })
    expect(result.stderr).toContain('broker_start_failed')
  }, 15_000)

  it('returns non-zero on a first_turn_missing trip and names the diagnostics seq', async () => {
    const socket = startDaemon({ sessionFound: false, events: [TURN_ACCEPTED, FIRST_TURN_MISSING] })
    const result = await timedTurn(socket, '8m')

    expect(result.exitCode).not.toBe(0)
    expect(result.elapsedMs).toBeLessThan(5_000)
    const failure = jsonLines(result.stdout).find((line) => line['result'] === 'turn_failed')
    expect(failure).toMatchObject({
      eventKind: 'first_turn_missing',
      code: 'first_turn_missing',
      diagnosticsSeq: 2296972,
    })
  }, 15_000)

  it('--timeout bounds a watched turn the server never ends', async () => {
    const socket = startDaemon({ sessionFound: false, events: [TURN_ACCEPTED] })
    const result = await timedTurn(socket, '1s')

    expect(result.exitCode).not.toBe(0)
    expect(result.elapsedMs).toBeLessThan(5_000)
    expect(
      jsonLines(result.stdout).find((line) => line['result'] === 'wait_timeout')
    ).toMatchObject({
      result: 'wait_timeout',
      timeoutMs: 1_000,
      runId: RUN,
    })
  }, 15_000)

  it('--timeout bounds the server-side steer wait door', async () => {
    const socket = startDaemon({ sessionFound: true, events: [], steerHangs: true })
    const result = await timedTurn(socket, '1s')

    expect(result.exitCode).not.toBe(0)
    expect(result.elapsedMs).toBeLessThan(5_000)
    expect(
      jsonLines(result.stdout).find((line) => line['result'] === 'wait_timeout')
    ).toMatchObject({
      result: 'wait_timeout',
      timeoutMs: 1_000,
    })
  }, 15_000)

  it('exits non-zero when the waited steer door settles the turn failed', async () => {
    // The body HRC returns once the waited run fails before any broker disposition.
    const socket = startDaemon({
      sessionFound: true,
      events: [],
      steerResponse: {
        runId: RUN,
        hostSessionId: HSID,
        runtimeId: RUNTIME,
        generation: 1,
        transport: 'headless',
        submissionId: 'input-start-failed',
        admission: 'admitted',
        stage: 'terminal',
        status: 'failed',
        outcome: 'failed',
        replayed: false,
        error: {
          code: 'runtime_unavailable',
          message: 'OAuth mode requires dispatchEnv.HARNESS_PI_AUTH_STORE',
        },
      },
    })
    const result = await timedTurn(socket, '8m')

    expect(result.exitCode).not.toBe(0)
    expect(result.elapsedMs).toBeLessThan(5_000)
    expect(jsonLines(result.stdout)[0]).toMatchObject({ status: 'failed', runId: RUN })
    expect(result.stderr).toContain('HARNESS_PI_AUTH_STORE')
  }, 15_000)
})
