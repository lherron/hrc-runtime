/**
 * T-08137 — daemon lifecycle provenance (Daedalus-approved rev 4, EN-19426).
 *
 * Before this, WHO restarted the daemon and WHY lived only in an err.log line
 * that the shutdown-intent file's consume-on-read made the sole copy. These
 * gates hold the durable replacement to its stated meaning:
 *
 *  - `server.stopped` attests that EVERY teardown step before the store closed
 *    completed. Any swallowed failure, drain timeout, socket-unlink error, or an
 *    expired foreground deadline withholds it, so the successor classifies the
 *    predecessor as `server.previous_exit_unattributed`.
 *  - Lock release runs after the store closes and is outside the attestation:
 *    its failure leaves `server.stopped` in place and stop() still rejects.
 *  - Only the production lifecycle integration writes any of this. An embedded
 *    or test `createHrcServer` is silent unless explicitly configured.
 *  - The server timeline producer advances its cursor only on an accepted post.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createHrcServer } from '../index.js'
import type { HrcServer, HrcServerOptions } from '../index.js'
import { SERVER_EVENT_SCOPE_REF, type ServerShutdownAttribution } from '../server-lifecycle.js'
import {
  SERVER_PROJECT_EVENTS_STREAM,
  deriveServerProjectEvent,
  serverProjectEventIdempotencyKey,
} from '../wrkq/server-project-events.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

type Row = {
  hrc_seq: number
  ts: string
  host_session_id: string
  scope_ref: string
  lane_ref: string
  generation: number
  category: string
  event_kind: string
  payload_json: string
}

// Private seams the stop-completeness gates inject failures through.
type Inspectable = HrcServer & {
  db: {
    hrcEvents: { ledgerIncarnationId(): string }
    wrkqLedgerCursors: { get(s: string): number | undefined }
  }
  zombieSweepInFlight: Promise<unknown> | undefined
  activeRunReconcileInFlight: Promise<unknown> | undefined
  firstTurnEvalInFlight: Promise<unknown> | undefined
  retainedEvidencePassInFlight: Promise<unknown> | undefined
  brokerLeaseGcInFlight: Promise<unknown> | undefined
  tmuxAgingInFlight: Promise<unknown> | undefined
  sessionRetentionInFlight: Promise<unknown> | undefined
  shadowTeardownInFlight: Promise<unknown> | undefined
  activeStreamClosers: Set<() => void>
  externalParticipantClients: Map<string, { close(): Promise<void> }>
  externalRegistrationOperations: Map<string, Promise<void>>
  exactRouteHandlers: Record<string, (request: Request, url: URL) => Promise<Response> | Response>
  serverProjectEvents: { drain(): Promise<void> } | undefined
  beginLifecycleShutdown(attribution: ServerShutdownAttribution): void
  markShutdownDeadlineExpired(): void
}

const SEAT_ATTRIBUTION: ServerShutdownAttribution = {
  reason: 'SIGTERM',
  callerKind: 'seat',
  requestedBy: 'agent:clod:project:hrc-runtime:task:T-08137/lane:main',
  requestedAction: 'restart',
  requestedRunId: 'run-t08137',
  requestedReason: 'T-08137 smoke',
  requestedByPid: 4242,
}

const NO_INTENT: ServerShutdownAttribution = {
  reason: 'SIGTERM',
  callerKind: null,
  requestedBy: null,
  requestedAction: null,
  requestedRunId: null,
  requestedReason: null,
  requestedByPid: null,
}

function rejected(message: string): Promise<never> {
  const promise = Promise.reject(new Error(message))
  promise.catch(() => undefined)
  return promise
}

describe('T-08137 daemon lifecycle provenance', () => {
  let fixture: HrcServerTestFixture
  let ledger: FakeWrkqLedger
  let stderr: string[]
  let restoreStderr: () => void

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t08137-')
    ledger = new FakeWrkqLedger()
    stderr = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderr.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write
    restoreStderr = () => {
      process.stderr.write = original
    }
  })

  afterEach(async () => {
    restoreStderr()
    await fixture.cleanup()
  })

  function lifecycleOpts(overrides: Partial<HrcServerOptions> = {}): HrcServerOptions {
    return fixture.serverOpts({ lifecycleProvenance: true, wrkqLedger: ledger, ...overrides })
  }

  async function startLifecycle(overrides: Partial<HrcServerOptions> = {}): Promise<Inspectable> {
    return (await createHrcServer(lifecycleOpts(overrides))) as Inspectable
  }

  function serverRows(): Row[] {
    const db = new Database(fixture.dbPath, { readonly: true })
    try {
      return db
        .query<Row, []>(
          `SELECT hrc_seq, ts, host_session_id, scope_ref, lane_ref, generation, category,
                  event_kind, payload_json
             FROM hrc_events WHERE event_kind GLOB 'server.*' ORDER BY hrc_seq`
        )
        .all()
    } finally {
      db.close()
    }
  }

  function kinds(): string[] {
    return serverRows().map((row) => row.event_kind)
  }

  function payload(row: Row | undefined): Record<string, unknown> {
    return JSON.parse(row?.payload_json ?? '{}') as Record<string, unknown>
  }

  function incompleteReasons(): string[][] {
    return stderr
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.includes(' server.stop.incomplete '))
      .map((line) => {
        const json = line.slice(line.indexOf('{'))
        return (JSON.parse(json) as { reasons: string[] }).reasons
      })
  }

  it('records started with sentinel identity and full boot provenance', async () => {
    const server = await startLifecycle()
    await server.stop()

    const [started] = serverRows()
    expect(started?.event_kind).toBe('server.started')
    expect(started?.category).toBe('server')
    expect(started?.host_session_id).toBe('hrc-server')
    expect(started?.scope_ref).toBe(SERVER_EVENT_SCOPE_REF)
    expect(started?.scope_ref).toBe('server:hrc')
    expect(started?.lane_ref).toBe('main')
    expect(started?.generation).toBe(0)
    const body = payload(started)
    expect(body['pid']).toBe(process.pid)
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(['pid', 'release', 'sourceCommit', 'storeSchema', 'processStartedAt'])
    )
    expect(typeof body['storeSchema']).toBe('string')
    expect(body['previousPid']).toBeUndefined()
  })

  it('a completed attributed stop yields shutting_down then stopped; the successor is clean', async () => {
    const first = await startLifecycle()
    first.beginLifecycleShutdown(SEAT_ATTRIBUTION)
    await first.stop()

    const rows = serverRows()
    expect(rows.map((row) => row.event_kind)).toEqual([
      'server.started',
      'server.shutting_down',
      'server.stopped',
    ])
    const shuttingDown = rows[1]
    expect(payload(shuttingDown)).toEqual({ pid: process.pid, ...SEAT_ATTRIBUTION })
    expect(payload(rows[2])).toEqual({
      pid: process.pid,
      ...SEAT_ATTRIBUTION,
      shuttingDownHrcSeq: shuttingDown?.hrc_seq,
    })

    const second = await startLifecycle()
    const status = (await (await fixture.fetchSocket('/v1/status')).json()) as {
      lastRestart: unknown
    }
    await second.stop()

    const after = serverRows()
    expect(after.map((row) => row.event_kind)).toEqual([
      'server.started',
      'server.shutting_down',
      'server.stopped',
      'server.started',
    ])
    expect(payload(after[3])['previousPid']).toBe(process.pid)
    expect(status.lastRestart).toEqual({
      at: after[3]?.ts,
      requestedBy: SEAT_ATTRIBUTION.requestedBy,
      reason: 'T-08137 smoke',
    })
  })

  it('a no-intent stop records explicit nulls and renders external attribution', async () => {
    const first = await startLifecycle()
    first.beginLifecycleShutdown(NO_INTENT)
    await first.stop()
    const shuttingDown = serverRows()[1]
    expect(payload(shuttingDown)).toEqual({ pid: process.pid, ...NO_INTENT })

    const second = await startLifecycle()
    const status = (await (await fixture.fetchSocket('/v1/status')).json()) as {
      lastRestart: unknown
    }
    await second.serverProjectEvents?.drain()
    await second.stop()

    expect(status.lastRestart).toEqual({
      at: serverRows()[3]?.ts,
      requestedBy: null,
      reason: null,
    })
    const stopped = ledger.projectEventPosts.find((post) => post.type === 'server.stopped')
    expect(stopped?.attributes['requested_by']).toBe('external')
    expect(stopped?.attributes['reason']).toBeUndefined()
  })

  it('an unmatched predecessor start yields exactly one previous_exit_unattributed', async () => {
    // A kill/crash: the predecessor never initiated shutdown, so its latest
    // fact is its own server.started.
    const first = await startLifecycle()
    await first.stop()
    expect(kinds()).toEqual(['server.started'])

    const second = await startLifecycle()
    const status = (await (await fixture.fetchSocket('/v1/status')).json()) as {
      lastRestart: unknown
    }
    await second.stop()

    const rows = serverRows()
    expect(rows.map((row) => row.event_kind)).toEqual([
      'server.started',
      'server.previous_exit_unattributed',
      'server.started',
    ])
    expect(payload(rows[1])).toEqual({ previousPid: process.pid })
    expect(status.lastRestart).toEqual({ at: rows[2]?.ts, requestedBy: null, reason: null })
  })

  it('shutdown initiation without a completed stop is unattributed, not stopped', async () => {
    const first = await startLifecycle()
    first.beginLifecycleShutdown(SEAT_ATTRIBUTION)
    first.zombieSweepInFlight = rejected('sweep wedged')
    await first.stop()
    expect(kinds()).toEqual(['server.started', 'server.shutting_down'])

    const second = await startLifecycle()
    await second.serverProjectEvents?.drain()
    await second.stop()
    expect(kinds()).toEqual([
      'server.started',
      'server.shutting_down',
      'server.previous_exit_unattributed',
      'server.started',
    ])
    // The timeline never carries shutdown initiation or a false stop: only the
    // two starts are posted.
    expect(ledger.projectEventPosts.map((post) => post.type)).toEqual([
      'server.started',
      'server.started',
    ])
  })

  describe('no false completed stop on any incomplete teardown', () => {
    const cases: Array<{
      reason: string
      inject: (server: Inspectable) => void | Promise<void>
    }> = [
      {
        reason: 'zombie_sweep_wait_failed',
        inject: (s) => {
          s.zombieSweepInFlight = rejected('x')
        },
      },
      {
        reason: 'active_run_reconcile_wait_failed',
        inject: (s) => {
          s.activeRunReconcileInFlight = rejected('x')
        },
      },
      {
        reason: 'first_turn_eval_wait_failed',
        inject: (s) => {
          s.firstTurnEvalInFlight = rejected('x')
        },
      },
      {
        reason: 'retained_evidence_pass_wait_failed',
        inject: (s) => {
          s.retainedEvidencePassInFlight = rejected('x')
        },
      },
      {
        reason: 'broker_lease_gc_wait_failed',
        inject: (s) => {
          s.brokerLeaseGcInFlight = rejected('x')
        },
      },
      {
        reason: 'tmux_aging_wait_failed',
        inject: (s) => {
          s.tmuxAgingInFlight = rejected('x')
        },
      },
      {
        reason: 'session_retention_wait_failed',
        inject: (s) => {
          s.sessionRetentionInFlight = rejected('x')
        },
      },
      {
        reason: 'shadow_teardown_wait_failed',
        inject: (s) => {
          s.shadowTeardownInFlight = rejected('x')
        },
      },
      {
        reason: 'stream_close_failed',
        inject: (s) =>
          void s.activeStreamClosers.add(() => {
            throw new Error('closer threw')
          }),
      },
      {
        reason: 'external_participant_close_failed',
        inject: (s) =>
          void s.externalParticipantClients.set('epr-1', { close: () => rejected('close failed') }),
      },
      {
        reason: 'participant_operation_failed',
        inject: (s) => void s.externalRegistrationOperations.set('reg-1', rejected('op failed')),
      },
      {
        reason: 'wrkq_ledger_close_failed',
        inject: () => {
          ledger.close = () => rejected('ledger close failed')
        },
      },
      {
        reason: 'socket_unlink_failed',
        inject: async () => {
          // A non-empty directory where the socket was: unlink fails.
          await rm(fixture.socketPath, { force: true })
          await mkdir(join(fixture.socketPath, 'occupied'), { recursive: true })
        },
      },
    ]

    for (const { reason, inject } of cases) {
      it(`${reason} withholds server.stopped and names the reason`, async () => {
        const first = await startLifecycle()
        first.beginLifecycleShutdown(SEAT_ATTRIBUTION)
        // Let the startup timers (the setTimeout(0) retained-evidence pass) run
        // first, so only stop() ever awaits the injected failure.
        await Bun.sleep(20)
        await inject(first)
        await first.stop().catch(() => undefined)

        expect(kinds()).toEqual(['server.started', 'server.shutting_down'])
        const reasons = incompleteReasons()
        expect(reasons).toHaveLength(1)
        expect(reasons[0]).toContain(reason)

        if (reason === 'socket_unlink_failed') {
          await rm(fixture.socketPath, { recursive: true, force: true })
        }
        const second = await startLifecycle()
        await second.stop()
        expect(kinds().slice(2)).toEqual(['server.previous_exit_unattributed', 'server.started'])
      })
    }

    it('request_drain_timeout withholds server.stopped', async () => {
      const first = await startLifecycle()
      first.exactRouteHandlers['GET /v1/sessions'] = async () => {
        await Bun.sleep(4_000)
        return new Response('{}')
      }
      const parked = fixture.fetchSocket('/v1/sessions').catch(() => undefined)
      await Bun.sleep(100)
      first.beginLifecycleShutdown(SEAT_ATTRIBUTION)
      await first.stop()
      await parked
      expect(kinds()).toEqual(['server.started', 'server.shutting_down'])
      expect(incompleteReasons()[0]).toContain('request_drain_timeout')
    }, 15_000)

    it('tmux sweep drain timeout withholds server.stopped', async () => {
      const first = await startLifecycle()
      first.tmuxAgingInFlight = new Promise(() => undefined)
      first.beginLifecycleShutdown(SEAT_ATTRIBUTION)
      await first.stop()
      expect(kinds()).toEqual(['server.started', 'server.shutting_down'])
      expect(incompleteReasons()[0]).toContain('tmux_aging_wait_timeout')
    }, 15_000)
  })

  it('a stop() that completes after the foreground deadline fired writes no stopped fact', async () => {
    const first = await startLifecycle()
    first.beginLifecycleShutdown(SEAT_ATTRIBUTION)
    // A wait that succeeds, just late: nothing in teardown is incomplete.
    first.zombieSweepInFlight = Bun.sleep(200).then(() => ({}))
    const stopping = first.stop()
    await Bun.sleep(20)
    first.markShutdownDeadlineExpired()
    await stopping

    expect(incompleteReasons()).toEqual([])
    expect(kinds()).toEqual(['server.started', 'server.shutting_down'])
  })

  it('a post-close lock-release failure keeps server.stopped and stop() still rejects', async () => {
    const first = await startLifecycle()
    first.beginLifecycleShutdown(SEAT_ATTRIBUTION)
    // A directory where the lock file was: reading it back fails after db.close().
    await rm(fixture.lockPath, { force: true })
    await mkdir(join(fixture.lockPath, 'occupied'), { recursive: true })

    const outcome = await first.stop().then(
      () => 'resolved',
      () => 'rejected'
    )
    expect(outcome).toBe('rejected')
    expect(kinds()).toEqual(['server.started', 'server.shutting_down', 'server.stopped'])
    expect(incompleteReasons()).toEqual([])
  })

  it('a stop() never preceded by lifecycle shutdown writes no stopped fact', async () => {
    const server = await startLifecycle()
    await server.stop()
    expect(kinds()).toEqual(['server.started'])
  })

  it('an embedded server records no lifecycle facts and reports lastRestart null', async () => {
    const server = await createHrcServer(fixture.serverOpts({ wrkqLedger: ledger }))
    const status = (await (await fixture.fetchSocket('/v1/status')).json()) as {
      lastRestart: unknown
    }
    ;(server as Inspectable).beginLifecycleShutdown(SEAT_ATTRIBUTION)
    await server.stop()
    expect(kinds()).toEqual([])
    expect(status.lastRestart).toBeNull()
    expect(ledger.projectEventPosts).toEqual([])
  })

  it('server facts stay out of scope-filtered reads', async () => {
    const server = await startLifecycle()
    const filtered = await (
      await fixture.fetchSocket('/v1/events?scopeRef=agent:clod:project:hrc-runtime')
    ).text()
    const explicit = await (
      await fixture.fetchSocket(`/v1/events?scopeRef=${encodeURIComponent('server:hrc')}`)
    ).text()
    await server.stop()
    expect(filtered).not.toContain('server.started')
    expect(explicit).toContain('server.started')
  })

  describe('server timeline producer', () => {
    it('posts started/stopped on hrc-runtime with the node/incarnation/seq key', async () => {
      const first = await startLifecycle()
      first.beginLifecycleShutdown(SEAT_ATTRIBUTION)
      await first.serverProjectEvents?.drain()
      await first.stop()

      const second = await startLifecycle()
      await second.serverProjectEvents?.drain()
      const incarnation = second.db.hrcEvents.ledgerIncarnationId()
      const cursor = second.db.wrkqLedgerCursors.get(SERVER_PROJECT_EVENTS_STREAM)
      await second.stop()

      const rows = serverRows()
      const types = ledger.projectEventPosts.map((post) => post.type)
      expect(types).toEqual(['server.started', 'server.stopped', 'server.started'])
      for (const post of ledger.projectEventPosts) {
        expect(post.project).toBe('hrc-runtime')
        expect(post.task).toBeUndefined()
        expect(post.attributes['source']).toBe('hrc-server')
        expect(post.idempotencyKey).toMatch(new RegExp(`^server:[^:]+:${incarnation}:\\d+$`))
      }
      const stopped = ledger.projectEventPosts[1]
      expect(stopped?.attributes['requested_by']).toBe(SEAT_ATTRIBUTION.requestedBy)
      expect(stopped?.attributes['reason']).toBe('T-08137 smoke')
      expect(stopped?.idempotencyKey?.endsWith(`:${rows[2]?.hrc_seq}`)).toBe(true)
      expect(cursor).toBe(rows[3]?.hrc_seq)
    })

    it('a rejected post leaves the cursor unchanged and a retry collapses onto one fact', async () => {
      ledger.unavailable = true
      const first = await startLifecycle()
      const before = first.db.wrkqLedgerCursors.get(SERVER_PROJECT_EVENTS_STREAM)
      await first.serverProjectEvents?.drain()
      expect(first.db.wrkqLedgerCursors.get(SERVER_PROJECT_EVENTS_STREAM)).toBe(before)
      expect(stderr.join('')).toContain('server_project_event.post_failed')

      ledger.unavailable = false
      await first.serverProjectEvents?.drain()
      await first.serverProjectEvents?.drain()
      const started = serverRows()[0]
      expect(first.db.wrkqLedgerCursors.get(SERVER_PROJECT_EVENTS_STREAM)).toBe(started?.hrc_seq)
      await first.stop()

      const accepted = ledger.projectEventPosts.filter((post) => post.type === 'server.started')
      expect(accepted).toHaveLength(1)
    })

    it('separates the idempotency key by node and ledger incarnation', () => {
      const a = serverProjectEventIdempotencyKey({
        nodeId: 'max3',
        ledgerIncarnationId: 'L1',
        hrcSeq: 7,
      })
      expect(a).toBe('server:max3:L1:7')
      expect(
        serverProjectEventIdempotencyKey({ nodeId: 'svc', ledgerIncarnationId: 'L1', hrcSeq: 7 })
      ).not.toBe(a)
      expect(
        serverProjectEventIdempotencyKey({ nodeId: 'max3', ledgerIncarnationId: 'L2', hrcSeq: 7 })
      ).not.toBe(a)
    })

    it('does not project shutdown initiation or unattributed predecessors', () => {
      for (const eventKind of ['server.shutting_down', 'server.previous_exit_unattributed']) {
        expect(
          deriveServerProjectEvent({
            event: { hrcSeq: 3, ts: '2026-09-27T00:00:00.000Z', eventKind, payload: { pid: 1 } },
            nodeId: 'max3',
            ledgerIncarnationId: 'L1',
          })
        ).toBeUndefined()
      }
    })
  })
})

/**
 * The site-coverage gate. Every continue-past-failure point in stop() before
 * the store closes must record a teardownIncomplete reason; a future site added
 * without one fails here rather than silently re-opening a false stopped fact.
 */
describe('T-08137 stop() site coverage', () => {
  it('every catch, allSettled, and drain outcome before db.close() records a reason', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'index.ts'), 'utf8')
    const start = source.indexOf('  async stop(): Promise<void> {')
    expect(start).toBeGreaterThan(0)
    const end = source.indexOf('this.db.close()', start)
    expect(end).toBeGreaterThan(start)
    const body = source.slice(start, end)

    const records = (segment: string) =>
      segment.includes('incomplete(') || segment.includes('teardownIncomplete.push(')

    function blockAfter(index: number): string {
      const open = body.indexOf('{', index)
      let depth = 0
      for (let i = open; i < body.length; i += 1) {
        if (body[i] === '{') depth += 1
        if (body[i] === '}') {
          depth -= 1
          if (depth === 0) return body.slice(open, i + 1)
        }
      }
      return body.slice(open)
    }

    function callAfter(index: number): string {
      const open = body.indexOf('(', index)
      let depth = 0
      for (let i = open; i < body.length; i += 1) {
        if (body[i] === '(') depth += 1
        if (body[i] === ')') {
          depth -= 1
          if (depth === 0) return body.slice(open, i + 1)
        }
      }
      return body.slice(open)
    }

    const sites: Array<{ kind: string; at: number; covered: boolean }> = []
    for (const match of body.matchAll(/\bcatch \(/g)) {
      sites.push({ kind: 'catch', at: match.index, covered: records(blockAfter(match.index)) })
    }
    for (const match of body.matchAll(/\.catch\(/g)) {
      sites.push({ kind: '.catch', at: match.index, covered: records(callAfter(match.index)) })
    }
    for (const match of body.matchAll(
      /allSettled\(|drainInFlightRequests\(|drainTmuxSweepForStop\(/g
    )) {
      // The outcome must be consumed into a reason within the same statement group.
      sites.push({
        kind: match[0],
        at: match.index,
        covered: records(body.slice(match.index, match.index + 400)),
      })
    }

    const uncovered = sites.filter((site) => !site.covered)
    expect(uncovered).toEqual([])
    // Vacuity guard: the extractor must actually see today's sites.
    expect(sites.filter((site) => site.kind === 'catch').length).toBeGreaterThanOrEqual(8)
    expect(sites.filter((site) => site.kind === '.catch').length).toBeGreaterThanOrEqual(2)
    expect(sites.filter((site) => site.kind === 'allSettled(').length).toBeGreaterThanOrEqual(1)
    // The three registration/establishment drains all reach a settled check.
    for (const operations of [
      'this.externalRegistrationOperations.values()',
      'this.externalRegistrationEstablishmentOperations.values()',
      'this.participantEstablishmentOperations.values()',
    ]) {
      expect(body).toContain(operations)
    }
    expect(sites.filter((site) => site.kind === 'drainTmuxSweepForStop(').length).toBe(2)
    expect(sites.filter((site) => site.kind === 'drainInFlightRequests(').length).toBe(1)

    for (const reason of [
      'request_drain_timeout',
      'peer_protocol_listener_failed',
      'binding_registry_listener_failed',
      'zombie_sweep_wait_failed',
      'first_turn_eval_wait_failed',
      'retained_evidence_pass_wait_failed',
      'broker_lease_gc_wait_failed',
      'session_retention_wait_failed',
      'shadow_teardown_wait_failed',
      'wrkq_ledger_close_failed',
      'stream_close_failed',
      'external_participant_close_failed',
      'participant_operation_failed',
    ]) {
      expect(body).toContain(`'${reason}'`)
    }
  })

  it('socket unlink and metrics flush run before db.close(); lock release after', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'index.ts'), 'utf8')
    const start = source.indexOf('  async stop(): Promise<void> {')
    const stop = source.slice(start, source.indexOf('\n  }\n', start))
    const close = stop.indexOf('this.db.close()')
    expect(stop.indexOf('unlinkIfExists(this.options.socketPath)')).toBeLessThan(close)
    expect(stop.indexOf('flushServerMetrics(')).toBeLessThan(close)
    expect(stop.indexOf('appendServerStopped')).toBeLessThan(close)
    expect(stop.indexOf('releaseServerLock(')).toBeGreaterThan(close)
  })
})
