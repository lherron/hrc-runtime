/**
 * T-09760 — a GET /v1/runtimes that never settles.
 *
 * Organic evidence (max3): three graceful stops timed out the request drain,
 * each on exactly one GET /v1/runtimes aged 10.2h, 10.6h and 4.2h. The route
 * is a plain JSON read; its only awaits are the per-runtime liveness
 * reconciles (tmux probes). One reconcile that never settles pins the request
 * for the daemon's whole life and withholds server.stopped.
 *
 * The hung dependency is injected at the real call inside the real reconcile
 * (`this.tmux.inspectSession`), so route, reconcile, in-flight tracker and stop
 * drain are all production code.
 *
 * The tracker half of the question is answered here too: an entry leaves the
 * tracker when the HANDLER settles, whatever the client does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot } from 'hrc-core'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const HOST_SESSION_ID = 'hsid-09760-list'
const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-09760:list'
const RUNTIME_ID = 'rt-09760-list'
const DEADLINE_MS = 300

type Inspectable = HrcServer & {
  zombieSweepInFlight?: Promise<unknown> | undefined
  shadowTeardownInFlight?: Promise<unknown> | undefined
  tmux: { inspectSession: (sessionName: string) => Promise<unknown> }
  inFlightRequests: Map<Promise<void>, unknown>
  exactRouteHandlers: Record<string, (request: Request, url: URL) => Promise<Response> | Response>
}

let fixture: HrcServerTestFixture
let server: Inspectable | undefined
let stderr: string[]
let restoreStderr: () => void

function logLines(event: string): Array<Record<string, unknown>> {
  return stderr
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.includes(` ${event} `))
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>)
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t09760-')
  stderr = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  restoreStderr = () => {
    process.stderr.write = original
  }
  server = (await createHrcServer(
    fixture.serverOpts({ otelListenerEnabled: false, runtimeListReconcileDeadlineMs: DEADLINE_MS })
  )) as Inspectable
})

afterEach(async () => {
  restoreStderr()
  if (server) await server.stop().catch(() => undefined)
  server = undefined
  await fixture.cleanup()
})

describe('T-09760 GET /v1/runtimes with a reconcile that never settles', () => {
  it('answers from the stored row by the deadline and names the runtime', async () => {
    fixture.seedSession(HOST_SESSION_ID, SCOPE_REF)
    fixture.seedTmuxRuntime(HOST_SESSION_ID, SCOPE_REF, RUNTIME_ID, { status: 'ready' })
    server!.tmux.inspectSession = () => new Promise(() => undefined)

    const startedAt = performance.now()
    const res = await fixture.fetchSocket('/v1/runtimes', { signal: AbortSignal.timeout(5_000) })
    const elapsedMs = performance.now() - startedAt

    expect(res.status).toBe(200)
    const body = (await res.json()) as HrcRuntimeSnapshot[]
    expect(body.find((runtime) => runtime.runtimeId === RUNTIME_ID)?.status).toBe('ready')
    expect(elapsedMs).toBeGreaterThanOrEqual(DEADLINE_MS - 10)
    expect(elapsedMs).toBeLessThan(DEADLINE_MS + 2_000)

    const missed = logLines('runtime_list.reconcile_deadline')
    expect(missed).toHaveLength(1)
    expect(missed[0]).toMatchObject({
      runtimeId: RUNTIME_ID,
      transport: 'tmux',
      deadlineMs: DEADLINE_MS,
    })

    // The request left the tracker, so a stop drains it instead of timing out.
    expect(server!.inFlightRequests.size).toBe(0)
    await server!.stop()
    server = undefined
    expect(logLines('server.stop.request_drain').filter((l) => l['outcome'] === 'timeout')).toEqual(
      []
    )
  }, 15_000)

  it('a reconcile that settles inside the deadline is used as before', async () => {
    fixture.seedSession(HOST_SESSION_ID, SCOPE_REF)
    fixture.seedTmuxRuntime(HOST_SESSION_ID, SCOPE_REF, RUNTIME_ID, { status: 'ready' })
    // The fixture tmux has no such session: the real reconcile marks it dead.
    const res = await fixture.fetchSocket('/v1/runtimes?all=true', {
      signal: AbortSignal.timeout(5_000),
    })
    const body = (await res.json()) as HrcRuntimeSnapshot[] | { error: unknown }
    expect(logLines('runtime_list.reconcile_deadline')).toEqual([])
    if (Array.isArray(body)) {
      expect(body.find((runtime) => runtime.runtimeId === RUNTIME_ID)?.status).toBe('dead')
    } else {
      expect(res.status).toBe(503)
    }
  }, 15_000)
})

describe('T-09760 the in-flight tracker follows the handler, not the client', () => {
  async function settleAndCount(): Promise<number> {
    await Bun.sleep(600)
    return server!.inFlightRequests.size
  }

  it('a client that aborts mid-handler leaves no entry once the handler finishes', async () => {
    server!.exactRouteHandlers['GET /v1/sessions'] = async () => {
      await Bun.sleep(300)
      return new Response('{}')
    }
    await fixture
      .fetchSocket('/v1/sessions', { signal: AbortSignal.timeout(50) })
      .catch(() => undefined)
    expect(await settleAndCount()).toBe(0)
  })

  it('a handler that throws leaves no entry', async () => {
    server!.exactRouteHandlers['GET /v1/sessions'] = async () => {
      await Bun.sleep(20)
      throw new Error('handler threw')
    }
    const res = await fixture.fetchSocket('/v1/sessions')
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(await settleAndCount()).toBe(0)
  })

  it('a streaming body the client never finishes reading leaves no entry', async () => {
    server!.exactRouteHandlers['GET /v1/sessions'] = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'))
          },
        }),
        { headers: { 'x-hrc-streaming': '1' } }
      )
    await fixture
      .fetchSocket('/v1/sessions', { signal: AbortSignal.timeout(200) })
      .then((res) => res.text())
      .catch(() => undefined)
    expect(await settleAndCount()).toBe(0)
  })
})

describe('T-09760 stop() bounds every teardown wait and names each step', () => {
  it('a sweep that never settles costs one step bound, is named, and stop completes', async () => {
    // Let startup timers run first, so only stop() awaits the injected sweeps.
    await Bun.sleep(20)
    server!.zombieSweepInFlight = new Promise(() => undefined)
    server!.shadowTeardownInFlight = new Promise(() => undefined)

    const startedAt = performance.now()
    const outcome = await Promise.race([
      server!.stop().then(() => 'stopped' as const),
      Bun.sleep(25_000).then(() => 'still pending' as const),
    ])
    const elapsedMs = performance.now() - startedAt
    server = undefined

    expect(outcome).toBe('stopped')
    // Two wedged waits, each capped at the 5s step bound.
    expect(elapsedMs).toBeLessThan(12_000)
    expect(logLines('server.stop.zombie_sweep_wait_timeout')).toHaveLength(1)
    expect(logLines('server.stop.shadow_teardown_wait_timeout')).toHaveLength(1)
    expect(logLines('server.stop.complete')).toHaveLength(1)

    const steps = logLines('server.stop.step').map((line) => line['step'])
    for (const expected of [
      'listener',
      'event_forwarder',
      'zombie_sweep',
      'active_run_reconcile',
      'retained_evidence_pass',
      'tmux_aging',
      'shadow_teardown',
      'wrkq_ledger',
      'request_drain',
      'store_close',
      'lock_release',
    ]) {
      expect(steps).toContain(expected)
    }
    expect(steps.at(-1)).toBe('lock_release')
    // The step entered after a wedged one starts about one bound later.
    const at = (name: string) =>
      logLines('server.stop.step').find((line) => line['step'] === name)?.['sinceBeginMs'] as number
    expect(at('active_run_reconcile') - at('zombie_sweep')).toBeGreaterThanOrEqual(4_900)
  }, 30_000)
})
