import { Database } from 'bun:sqlite'
/** T-08566 C14/C14d: retained recovery never races live ownership. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'
import { HarnessBrokerController } from '../broker/controller'
import { BrokerEventMapper } from '../broker/event-mapper'
import { type HrcServer, createHrcServer } from '../index'
import { reattachDurableBrokerForDispatch } from '../startup-reconcile'
import {
  RUNTIME_ID,
  type SeededFixture,
  headlessSequence,
  makeSeededFixture,
} from './broker-event-mapper-fixtures'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import { seedOfflineRuntime } from './fixtures/t08566-offline-reader-double'

const RETAINED_FENCE = 'runtime_retained_evidence_projected'

function responseCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const error = (body as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object') return undefined
  return (error as { code?: string }).code
}

async function codeOf(response: Response): Promise<string | undefined> {
  return responseCode(await response.json().catch(() => undefined))
}

async function rejectionCode(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

function installRetainedMarker(db: HrcDatabase, invocationId: string, seq = 1): void {
  const columns = db.sqlite
    .query<{ name: string }, []>('PRAGMA table_info(broker_invocations)')
    .all()
  if (!columns.some((column) => column.name === 'retained_projected_through_seq')) {
    db.sqlite.exec(
      'ALTER TABLE broker_invocations ADD COLUMN retained_projected_through_seq INTEGER'
    )
  }
  db.sqlite
    .query<unknown, [number, string]>(
      'UPDATE broker_invocations SET retained_projected_through_seq = ? WHERE invocation_id = ?'
    )
    .run(seq, invocationId)
}

function openReadProbe(dbPath: string): Database {
  const db = new Database(dbPath, { readonly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

function retainedCursor(dbPath: string, invocationId: string): number | null {
  const db = openReadProbe(dbPath)
  try {
    return (
      db
        .query<{ retained_projected_through_seq: number | null }, [string]>(
          `SELECT retained_projected_through_seq
             FROM broker_invocations
            WHERE invocation_id = ?`
        )
        .get(invocationId)?.retained_projected_through_seq ?? null
    )
  } finally {
    db.close()
  }
}

function retainedCheckpoint(
  dbPath: string,
  invocationId: string
): { last_projected_seq: number; retained_projected_through_seq: number | null } | null {
  const db = openReadProbe(dbPath)
  try {
    return db
      .query<
        { last_projected_seq: number; retained_projected_through_seq: number | null },
        [string]
      >(
        `SELECT last_projected_seq, retained_projected_through_seq
           FROM broker_invocations
          WHERE invocation_id = ?`
      )
      .get(invocationId)
  } finally {
    db.close()
  }
}

function outcomeCount(dbPath: string, invocationId: string): number {
  const db = openReadProbe(dbPath)
  try {
    return (
      db
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM retained_evidence_outcomes WHERE invocation_id = ?'
        )
        .get(invocationId)?.count ?? 0
    )
  } finally {
    db.close()
  }
}

async function recordedReaderAfterSeq(recordPath: string): Promise<number | null> {
  if (!existsSync(recordPath)) return null
  try {
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as { stdin?: string }
    if (typeof record.stdin !== 'string') return null
    const request = JSON.parse(record.stdin) as { afterSeq?: unknown }
    return typeof request.afterSeq === 'number' ? request.afterSeq : null
  } catch {
    return null
  }
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

async function waitForProcessGroupExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && processGroupIsAlive(pid); attempt += 1) {
    await Bun.sleep(10)
  }
}

function durableOwnerRows(dbPath: string, runtimeId: string, invocationId: string): string {
  const db = openReadProbe(dbPath)
  try {
    return JSON.stringify({
      runtime: db
        .query<Record<string, unknown>, [string]>('SELECT * FROM runtimes WHERE runtime_id = ?')
        .get(runtimeId),
      invocation: db
        .query<Record<string, unknown>, [string]>(
          'SELECT * FROM broker_invocations WHERE invocation_id = ?'
        )
        .get(invocationId),
    })
  } finally {
    db.close()
  }
}

function runtimeRow(dbPath: string, runtimeId: string): string {
  const db = openReadProbe(dbPath)
  try {
    return JSON.stringify(
      db
        .query<Record<string, unknown>, [string]>('SELECT * FROM runtimes WHERE runtime_id = ?')
        .get(runtimeId)
    )
  } finally {
    db.close()
  }
}

async function captureStderr<T>(
  operation: () => Promise<T>
): Promise<{ value: T; stderr: string }> {
  const originalWrite = process.stderr.write
  let stderr = ''
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stderr.write
  try {
    return { value: await operation(), stderr }
  } finally {
    process.stderr.write = originalWrite
  }
}

function retainedStart(invocationId: string) {
  return {
    invocationId,
    seq: 1,
    time: '2026-09-17T12:00:01.000Z',
    type: 'invocation.started',
    payload: { pid: 4242, command: 'codex', args: ['app-server'], cwd: '/tmp/project' },
  }
}

async function operatorOwnershipRequests(
  fixture: Awaited<ReturnType<typeof createHrcTestFixture>>,
  seeded: Awaited<ReturnType<typeof seedOfflineRuntime>>
): Promise<Array<[string, Response]>> {
  return await Promise.all([
    fixture
      .postJson('/v1/runtimes/attach', { runtimeId: seeded.runtimeId })
      .then((r) => ['attach', r] as [string, Response]),
    fixture
      .postJson('/v1/runtimes/adopt', { runtimeId: seeded.runtimeId })
      .then((r) => ['adopt', r] as [string, Response]),
  ])
}

async function sessionDispatchRequests(
  fixture: Awaited<ReturnType<typeof createHrcTestFixture>>,
  seeded: Awaited<ReturnType<typeof seedOfflineRuntime>>
): Promise<Array<[string, Response]>> {
  return await Promise.all([
    fixture
      .postJson('/v1/turns', {
        hostSessionId: seeded.hostSessionId,
        prompt: 'retained fence probe',
      })
      .then((r) => ['turn', r] as [string, Response]),
    fixture
      .postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: seeded.sessionRef },
        body: 'retained fence probe',
      })
      .then((r) => ['dm', r] as [string, Response]),
  ])
}

function servingOperations(server: HrcServer): Map<string, Promise<unknown>> {
  return (server as unknown as { brokerReattachOperations: Map<string, Promise<unknown>> })
    .brokerReattachOperations
}

function brokerWindow(runtime: HrcRuntimeSnapshot): unknown {
  const substrate = (
    runtime.runtimeStateJson as {
      broker?: {
        substrate?: {
          tmuxSocketPath?: string
          sessionName?: string
          brokerWindow?: Record<string, unknown>
        }
      }
    }
  )?.broker?.substrate
  return {
    ...substrate?.brokerWindow,
    socketPath: substrate?.tmuxSocketPath,
    sessionName: substrate?.sessionName,
  }
}

function scriptedReattachDeps(
  server: HrcServer,
  runtimeRoot: string,
  runtime: HrcRuntimeSnapshot
): {
  calls: string[]
  deps: Parameters<typeof reattachDurableBrokerForDispatch>[2]
} {
  const calls: string[] = []
  return {
    calls,
    deps: {
      runtimeRoot,
      inFlightOperations: servingOperations(server) as Parameters<
        typeof reattachDurableBrokerForDispatch
      >[2]['inFlightOperations'],
      controller: {
        activeClientInvocationId: () => {
          calls.push('activeClientInvocationId')
          return undefined
        },
        attachAndReplay: async () => {
          calls.push('attachAndReplay')
          return {
            ok: true,
            brokerAttached: true,
            replayedThroughSeq: 0,
            ackedThroughSeq: 0,
            acceptedInputIds: [],
          }
        },
      },
      brokerUnixClientFactory: async () => ({}) as never,
      resolveAttachToken: async () => 't08566-attach-token',
      probeBrokerLease: async () => ({
        brokerSocketLive: true,
        brokerWindow: brokerWindow(runtime) as never,
        tuiWindow: null,
      }),
    },
  }
}

function requireRuntime(db: HrcDatabase, runtimeId: string): HrcRuntimeSnapshot {
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) throw new Error(`runtime fixture missing: ${runtimeId}`)
  return runtime
}

let fixture: SeededFixture
beforeEach(async () => {
  fixture = await makeSeededFixture()
})
afterEach(async () => fixture.cleanup())

describe('T-08566 stage 2 authority and ownership', () => {
  test('live projection remains a working positive control', () => {
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => new Date().toISOString() })
    for (const envelope of headlessSequence().slice(0, 4)) mapper.apply(envelope)
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('busy')
  })

  test('retained projection is a distinct mapper mode and atomically records its marker', () => {
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => new Date().toISOString() })
    const retained = (mapper as unknown as { applyRetained?: (value: unknown) => unknown })
      .applyRetained
    expect(typeof retained).toBe('function')
    retained!.call(mapper, headlessSequence()[0])
    const row = fixture.db.sqlite
      .query<{ retained_projected_through_seq: number | null }, []>(
        'SELECT retained_projected_through_seq FROM broker_invocations LIMIT 1'
      )
      .get()
    expect(row?.retained_projected_through_seq).toBe(1)
  })

  test('C14c: a delta-only retained commit advances the marker without mirroring origin rows', () => {
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => new Date().toISOString() })
    const applyRetained = (mapper as unknown as { applyRetained?: (value: unknown) => unknown })
      .applyRetained
    expect(typeof applyRetained).toBe('function')
    applyRetained!.call(mapper, {
      invocationId: 'invocation_broker_w3a',
      seq: 1,
      time: '2026-09-17T12:00:01.000Z',
      type: 'assistant.message.delta',
      turnId: 'turn-delta-only',
      payload: { messageId: 'msg-delta-only', text: 'retained fragment' },
    })
    mapper.flushIgnoredDeltas('invocation_broker_w3a', true)
    expect(
      fixture.db.sqlite
        .query<{ retained_projected_through_seq: number | null }, []>(
          'SELECT retained_projected_through_seq FROM broker_invocations LIMIT 1'
        )
        .get()?.retained_projected_through_seq
    ).toBe(1)
    expect(
      fixture.db.sqlite
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM hrc_events')
        .get()?.count
    ).toBe(0)
    expect(
      fixture.db.sqlite
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM broker_invocation_events')
        .get()?.count
    ).toBe(0)
  })

  test('C14b: every live ownership path and startup reconcile are fenced after a retained commit', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-fence-')
    let server: HrcServer | undefined
    try {
      const seeded = await seedOfflineRuntime(serverFixture, 'full', { status: 'failed' })
      const db = openHrcDatabase(serverFixture.dbPath)
      try {
        const mapper = new BrokerEventMapper({ db, now: () => serverFixture.now() })
        const applyRetained = (mapper as unknown as { applyRetained?: (value: unknown) => unknown })
          .applyRetained
        expect(typeof applyRetained).toBe('function')
        applyRetained!.call(mapper, retainedStart(seeded.invocationId))
      } finally {
        db.close()
      }
      const before = durableOwnerRows(serverFixture.dbPath, seeded.runtimeId, seeded.invocationId)
      const started = await captureStderr(async () => {
        const created = await createHrcServer(serverFixture.serverOpts())
        await Bun.sleep(30)
        return created
      })
      server = started.value

      expect(
        started.stderr
          .split('\n')
          .filter((line) => line.includes(seeded.runtimeId) && line.includes('attach'))
      ).toEqual([])
      expect(durableOwnerRows(serverFixture.dbPath, seeded.runtimeId, seeded.invocationId)).toBe(
        before
      )
      const live = await captureStderr(async () => ({
        ownership: await operatorOwnershipRequests(serverFixture, seeded),
        dispatch: await sessionDispatchRequests(serverFixture, seeded),
      }))
      expect(
        live.stderr
          .split('\n')
          .filter((line) => line.includes(seeded.runtimeId) && /attach|ackEvents/.test(line))
      ).toEqual([])
      for (const [path, response] of live.value.ownership) {
        expect({ path, status: response.status, code: await codeOf(response) }).toEqual({
          path,
          status: 409,
          code: RETAINED_FENCE,
        })
        expect(durableOwnerRows(serverFixture.dbPath, seeded.runtimeId, seeded.invocationId)).toBe(
          before
        )
      }
      for (const [path] of live.value.dispatch) {
        expect({
          path,
          rows: durableOwnerRows(serverFixture.dbPath, seeded.runtimeId, seeded.invocationId),
        }).toEqual({
          path,
          rows: before,
        })
      }
    } finally {
      await server?.stop()
      await serverFixture.cleanup()
    }
  })

  test('C14b control: unprojected runtimes are not refused by the retained-evidence fence', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-live-control-')
    const server = await createHrcServer(serverFixture.serverOpts())
    const seeded = await seedOfflineRuntime(serverFixture, 'full')
    try {
      const requests = [
        ...(await operatorOwnershipRequests(serverFixture, seeded)),
        ...(await sessionDispatchRequests(serverFixture, seeded)),
      ]
      for (const [path, response] of requests) {
        expect({ path, code: await codeOf(response) }).not.toEqual({ path, code: RETAINED_FENCE })
      }
    } finally {
      await server.stop()
      await serverFixture.cleanup()
    }
  })

  test('C14b shared dispatch reattach refuses a projected runtime before controller use', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-shared-seam-')
    const server = await createHrcServer(serverFixture.serverOpts())
    const projected = await seedOfflineRuntime(serverFixture, 'full', { status: 'ready' })
    const control = await seedOfflineRuntime(serverFixture, 'small-bytes', { status: 'ready' })
    const db = openHrcDatabase(serverFixture.dbPath)
    try {
      installRetainedMarker(db, projected.invocationId)
      const projectedRuntime = requireRuntime(db, projected.runtimeId)
      const controlRuntime = requireRuntime(db, control.runtimeId)
      const projectedDeps = scriptedReattachDeps(
        server,
        serverFixture.runtimeRoot,
        projectedRuntime
      )
      const controlDeps = scriptedReattachDeps(server, serverFixture.runtimeRoot, controlRuntime)

      const projectedCode = await rejectionCode(
        reattachDurableBrokerForDispatch(db, projectedRuntime, projectedDeps.deps)
      )
      const controlResult = await reattachDurableBrokerForDispatch(
        db,
        controlRuntime,
        controlDeps.deps
      )

      expect(controlResult).toEqual({ state: 'reattached' })
      expect(controlDeps.calls).toContain('attachAndReplay')
      expect({ code: projectedCode, controllerCalls: projectedDeps.calls }).toEqual({
        code: RETAINED_FENCE,
        controllerCalls: [],
      })
    } finally {
      db.close()
      await server.stop()
      await serverFixture.cleanup()
    }
  })

  test('C14b controller attach lower guard rejects before reading the broker client', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-controller-guard-')
    const seeded = await seedOfflineRuntime(serverFixture, 'full')
    const db = openHrcDatabase(serverFixture.dbPath)
    try {
      installRetainedMarker(db, seeded.invocationId)
      let clientUses = 0
      const client = new Proxy(
        {},
        {
          get() {
            clientUses += 1
            throw new Error('projected runtime reached broker client')
          },
        }
      )
      const controller = new HarnessBrokerController({
        db,
        now: () => serverFixture.now(),
        serverInstanceId: 't08566-lower-guard',
      })
      const code = await rejectionCode(
        controller.attachAndReplay({
          runtimeId: seeded.runtimeId,
          client: client as never,
          attachToken: 'must-not-be-used',
        })
      )

      expect({ code, clientUses }).toEqual({ code: RETAINED_FENCE, clientUses: 0 })
    } finally {
      db.close()
      await serverFixture.cleanup()
    }
  })

  test('C14b positive birth: a new start uses a different runtime and preserves its retained predecessor', async () => {
    const serverFixture = await createHrcTestFixture('t85b-')
    const server = await createHrcServer(serverFixture.serverOpts())
    try {
      const scopeRef = 'agent:smokey:project:hrc-runtime:task:T-08566-positive-birth'
      const sessionRef = `${scopeRef}/lane:default`
      const continuity = await serverFixture.resolveSession(scopeRef)
      expect(continuity).toMatchObject({ generation: 1 })
      const seeded = await seedOfflineRuntime(serverFixture, 'full')
      const db = openHrcDatabase(serverFixture.dbPath)
      try {
        const runtime = requireRuntime(db, seeded.runtimeId)
        db.runtimes.update(seeded.runtimeId, {
          hostSessionId: continuity.hostSessionId,
          scopeRef,
          laneRef: 'default',
          generation: continuity.generation,
          runtimeStateJson: {
            ...runtime.runtimeStateJson,
            hostSessionId: continuity.hostSessionId,
            generation: continuity.generation,
          },
        })
        installRetainedMarker(db, seeded.invocationId)
      } finally {
        db.close()
      }
      const predecessor = {
        ...seeded,
        hostSessionId: continuity.hostSessionId,
        scopeRef,
        sessionRef,
      }
      const before = durableOwnerRows(
        serverFixture.dbPath,
        predecessor.runtimeId,
        predecessor.invocationId
      )

      const started = await serverFixture.postJson('/v1/command-runs/launch', {
        configuredTargetId: 'test-command-run-success',
        sessionRef,
        idempotencyKey: ['t08566', 'retained', 'predecessor', 'birth'].join('-'),
        binding: {
          WRKF_TASK_ID: 'T-08566',
          WRKF_ACTION_RUN_ID: 't08566-positive-birth-action',
          WRKF_RUN_ID: 't08566-positive-birth-workflow',
          WRKF_ACTION: 'validate',
          WRKF_ROLE: 'smokey',
          ASP_PROJECT: 'hrc-runtime',
          HRC_SESSION_REF: sessionRef,
          HRC_LANE: 'default',
        },
        stdinJson: { expectedExit: 0 },
      })
      const body = (await started.json()) as { runtimeId?: string }
      expect(started.status).toBe(200)
      expect(body.runtimeId).toMatch(/^rt-/)
      expect(body.runtimeId).not.toBe(predecessor.runtimeId)
      const birthDb = openReadProbe(serverFixture.dbPath)
      try {
        expect(
          birthDb
            .query<{ runtime_id: string; host_session_id: string }, [string]>(
              'SELECT runtime_id, host_session_id FROM runtimes WHERE runtime_id = ?'
            )
            .get(body.runtimeId!)
        ).toEqual({
          runtime_id: body.runtimeId,
          host_session_id: continuity.hostSessionId,
        })
      } finally {
        birthDb.close()
      }
      expect(
        durableOwnerRows(serverFixture.dbPath, predecessor.runtimeId, predecessor.invocationId)
      ).toBe(before)

      for (const [path, response] of await operatorOwnershipRequests(serverFixture, predecessor)) {
        expect({ path, status: response.status, code: await codeOf(response) }).toEqual({
          path,
          status: 409,
          code: RETAINED_FENCE,
        })
        expect(
          durableOwnerRows(serverFixture.dbPath, predecessor.runtimeId, predecessor.invocationId)
        ).toBe(before)
      }
    } finally {
      await server.stop()
      await serverFixture.cleanup()
    }
  })

  test('recovery-first crossing makes attach wait, then refuse after the retained commit', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-crossing-')
    const server = await createHrcServer(serverFixture.serverOpts())
    let db: HrcDatabase | undefined
    try {
      const seeded = await seedOfflineRuntime(serverFixture, 'timeout')
      db = openHrcDatabase(serverFixture.dbPath)
      const beforeRuntime = runtimeRow(serverFixture.dbPath, seeded.runtimeId)
      const crossing = await captureStderr(async () => {
        const recovery = serverFixture.postJson('/v1/capture/recover', {
          runtimeId: seeded.runtimeId,
          yes: true,
        })
        for (let attempt = 0; attempt < 50 && !existsSync(seeded.reader.recordPath); attempt += 1) {
          await Bun.sleep(10)
        }
        if (!existsSync(seeded.reader.recordPath)) {
          return {
            readerSpawned: false,
            settledBeforeUnblock: [],
            settledAfterCompletion: [],
            recoveryStatus: (await recovery).status,
            responses: [] as Response[],
            directCode: undefined,
            controllerCalls: [] as string[],
          }
        }
        const directRuntime = requireRuntime(db!, seeded.runtimeId)
        const directDeps = scriptedReattachDeps(server, serverFixture.runtimeRoot, directRuntime)
        const responsePromises = [
          serverFixture.postJson('/v1/runtimes/attach', { runtimeId: seeded.runtimeId }),
          serverFixture.postJson('/v1/runtimes/adopt', { runtimeId: seeded.runtimeId }),
        ]
        const directPromise = rejectionCode(
          reattachDurableBrokerForDispatch(db!, directRuntime, directDeps.deps)
        )
        const pending = [...responsePromises, directPromise]
        const settled = [false, false, false]
        pending.forEach(
          (request, index) =>
            void request.finally(() => {
              settled[index] = true
            })
        )
        await Bun.sleep(20)
        const settledBeforeUnblock = [...settled]
        await writeFile(seeded.reader.unblockPath, '')
        const responses = await Promise.all(responsePromises)
        const directCode = await directPromise
        return {
          readerSpawned: true,
          settledBeforeUnblock,
          settledAfterCompletion: [...settled],
          recoveryStatus: (await recovery).status,
          responses,
          directCode,
          controllerCalls: directDeps.calls,
        }
      })
      expect(crossing.value.readerSpawned).toBe(true)
      expect(crossing.value.settledBeforeUnblock).toEqual([false, false, false])
      expect(crossing.value.settledAfterCompletion).toEqual([true, true, true])
      expect(crossing.value.recoveryStatus).toBe(200)
      for (const response of crossing.value.responses) {
        expect(response.status).toBe(409)
        expect(await codeOf(response)).toBe(RETAINED_FENCE)
      }
      expect({
        code: crossing.value.directCode,
        controllerCalls: crossing.value.controllerCalls,
      }).toEqual({
        code: RETAINED_FENCE,
        controllerCalls: [],
      })
      expect(runtimeRow(serverFixture.dbPath, seeded.runtimeId)).toBe(beforeRuntime)
      expect(
        crossing.stderr
          .split('\n')
          .filter((line) => line.includes(seeded.runtimeId) && /attach|ackEvents/.test(line))
      ).toEqual([])
    } finally {
      db?.close()
      await server.stop()
      await serverFixture.cleanup()
    }
  })

  test('C14d attach-first: recovery refuses without spawning, then retries after owner release', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-attach-first-')
    const server = await createHrcServer(serverFixture.serverOpts())
    const seeded = await seedOfflineRuntime(serverFixture, 'full')
    let releaseAttach!: () => void
    const attachOwner = new Promise<unknown>((resolve) => {
      releaseAttach = () => resolve(undefined)
    })
    const operations = (
      server as unknown as { brokerReattachOperations: Map<string, Promise<unknown>> }
    ).brokerReattachOperations
    operations.set(seeded.runtimeId, attachOwner)
    try {
      const refused = await serverFixture.postJson('/v1/capture/recover', {
        runtimeId: seeded.runtimeId,
        yes: true,
      })
      expect(refused.status).toBe(200)
      expect(await refused.json()).toMatchObject({ outcome: 'offline_read_attach_in_flight' })
      expect(existsSync(seeded.reader.recordPath)).toBe(false)
      expect(retainedCursor(serverFixture.dbPath, seeded.invocationId)).toBeNull()

      releaseAttach()
      operations.delete(seeded.runtimeId)
      const retried = await serverFixture.postJson('/v1/capture/recover', {
        runtimeId: seeded.runtimeId,
        yes: true,
      })
      expect(retried.status).toBe(200)
      expect(existsSync(seeded.reader.recordPath)).toBe(true)
    } finally {
      releaseAttach()
      operations.delete(seeded.runtimeId)
      await server.stop()
      await serverFixture.cleanup()
    }
  })

  test('C14d crashed runtimes are revivable and DM is not retained-fenced', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-crashed-')
    const seeded = await seedOfflineRuntime(serverFixture, 'full', { status: 'crashed' })
    const server = await createHrcServer(serverFixture.serverOpts())
    try {
      const refused = await serverFixture.postJson('/v1/capture/recover', {
        runtimeId: seeded.runtimeId,
        yes: true,
      })
      expect(refused.status).toBe(200)
      expect(await refused.json()).toMatchObject({ outcome: 'offline_read_runtime_revivable' })
      expect(existsSync(seeded.reader.recordPath)).toBe(false)
      const dm = await serverFixture.postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: seeded.sessionRef },
        body: 'revivable control',
      })
      expect(await codeOf(dm)).not.toBe(RETAINED_FENCE)
    } finally {
      await server.stop()
      await serverFixture.cleanup()
    }
  })

  test('C14c negative: pre-projection outcomes leave the marker null and live attach unfenced', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-negative-')
    const server = await createHrcServer(serverFixture.serverOpts())
    try {
      const unavailable = await seedOfflineRuntime(serverFixture, 'full')
      const empty = await seedOfflineRuntime(serverFixture, 'unknown-invocation')
      await Bun.$`mv ${unavailable.reader.root} ${`${unavailable.reader.root}.missing`}`.quiet()
      const unavailableResponse = await serverFixture.postJson('/v1/capture/recover', {
        runtimeId: unavailable.runtimeId,
        yes: true,
      })
      expect(unavailableResponse.status).toBe(200)
      expect(await unavailableResponse.json()).toMatchObject({ outcome: 'release_unavailable' })
      const emptyResponse = await serverFixture.postJson('/v1/capture/recover', {
        runtimeId: empty.runtimeId,
        yes: true,
      })
      expect(emptyResponse.status).toBe(200)
      expect(await emptyResponse.json()).toMatchObject({ outcome: 'recovered', complete: true })
      for (const seeded of [unavailable, empty]) {
        expect(retainedCursor(serverFixture.dbPath, seeded.invocationId)).toBeNull()
        const attach = await serverFixture.postJson('/v1/runtimes/attach', {
          runtimeId: seeded.runtimeId,
        })
        expect(await codeOf(attach)).not.toBe(RETAINED_FENCE)
      }
    } finally {
      await server.stop()
      await serverFixture.cleanup()
    }
  })

  test('C14c kill-before-outcome: a committed marker survives SIGKILL and fences restart', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-kill-')
    const seeded = await seedOfflineRuntime(serverFixture, 'block-page-two')
    const serverEntry = join(import.meta.dir, '..', 'index.ts')
    const childCode = `
      import { createHrcServer } from ${JSON.stringify(serverEntry)}
      const options = JSON.parse(process.env.T08566_SERVER_OPTIONS)
      await createHrcServer(options)
      process.stdout.write('READY\\n')
      await new Promise(() => {})
    `
    const child = Bun.spawn(['bun', '-e', childCode], {
      cwd: serverFixture.tmpDir,
      env: { ...process.env, T08566_SERVER_OPTIONS: JSON.stringify(serverFixture.serverOpts()) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const childStderr = new Response(child.stderr).text()
    let restarted: HrcServer | undefined
    let blockedReaderPid: number | undefined
    try {
      const stdout = child.stdout
      if (!(stdout instanceof ReadableStream)) throw new Error('child stdout is not readable')
      const reader = stdout.getReader()
      const readiness = await Promise.race([
        reader.read().then((result) => ({ kind: 'stdout' as const, result })),
        child.exited.then((exitCode) => ({ kind: 'exit' as const, exitCode })),
        Bun.sleep(5_000).then(() => ({ kind: 'timeout' as const })),
      ])
      reader.releaseLock()
      const readyText =
        readiness.kind === 'stdout' ? new TextDecoder().decode(readiness.result.value) : ''
      if (!readyText.includes('READY')) {
        if (child.exitCode === null) child.kill(9)
        const [exitCode, stderr] = await Promise.all([child.exited, childStderr])
        throw new Error(
          `child daemon did not become ready (${readiness.kind}, exit ${exitCode}): ${stderr.trim()}`
        )
      }

      const recovery = serverFixture
        .postJson('/v1/capture/recover', {
          runtimeId: seeded.runtimeId,
          yes: true,
        })
        .then(
          (response) => ({ kind: 'response' as const, response }),
          (error: unknown) => ({ kind: 'error' as const, error })
        )
      for (
        let attempt = 0;
        attempt < 500 && ((await recordedReaderAfterSeq(seeded.reader.recordPath)) ?? 0) === 0;
        attempt += 1
      ) {
        await Bun.sleep(20)
      }
      const blockedAfterSeq = await recordedReaderAfterSeq(seeded.reader.recordPath)
      expect(blockedAfterSeq).not.toBeNull()
      expect(blockedAfterSeq).toBeGreaterThan(0)
      blockedReaderPid = Number((await readFile(seeded.reader.pidPath, 'utf8')).trim())
      expect(Number.isSafeInteger(blockedReaderPid)).toBe(true)
      expect(retainedCursor(serverFixture.dbPath, seeded.invocationId)).not.toBeNull()
      expect(outcomeCount(serverFixture.dbPath, seeded.invocationId)).toBe(0)

      child.kill(9)
      await child.exited
      killProcessGroup(blockedReaderPid)
      await waitForProcessGroupExit(blockedReaderPid)
      expect(processGroupIsAlive(blockedReaderPid)).toBe(false)
      const interrupted = await recovery
      if (interrupted.kind === 'error') {
        expect({
          code: (interrupted.error as { code?: string }).code,
          message:
            interrupted.error instanceof Error
              ? interrupted.error.message
              : String(interrupted.error),
        }).toEqual({
          code: 'ECONNRESET',
          message: expect.stringContaining('socket connection was closed unexpectedly'),
        })
      } else {
        expect(interrupted.response.status).toBe(200)
        expect(await interrupted.response.json()).toMatchObject({
          outcome: 'offline_read_attach_in_flight',
        })
      }
      const checkpoint = retainedCheckpoint(serverFixture.dbPath, seeded.invocationId)
      expect(checkpoint?.last_projected_seq).toBeGreaterThan(0)
      expect(checkpoint?.retained_projected_through_seq).toBe(checkpoint?.last_projected_seq)
      expect(outcomeCount(serverFixture.dbPath, seeded.invocationId)).toBe(0)
      await writeFile(seeded.reader.recordPath, '')
      const restarting = createHrcServer(serverFixture.serverOpts())
      for (
        let attempt = 0;
        attempt < 500 && (await recordedReaderAfterSeq(seeded.reader.recordPath)) === null;
        attempt += 1
      ) {
        await Bun.sleep(20)
      }
      expect(await recordedReaderAfterSeq(seeded.reader.recordPath)).toBe(
        checkpoint!.last_projected_seq
      )
      await writeFile(seeded.reader.unblockPath, '')
      restarted = await restarting

      for (const [path, response] of await operatorOwnershipRequests(serverFixture, seeded)) {
        expect({ path, status: response.status, code: await codeOf(response) }).toEqual({
          path,
          status: 409,
          code: RETAINED_FENCE,
        })
      }
      const db = openHrcDatabase(serverFixture.dbPath)
      try {
        const runtime = requireRuntime(db, seeded.runtimeId)
        const directDeps = scriptedReattachDeps(restarted, serverFixture.runtimeRoot, runtime)
        expect({
          code: await rejectionCode(reattachDurableBrokerForDispatch(db, runtime, directDeps.deps)),
          controllerCalls: directDeps.calls,
        }).toEqual({ code: RETAINED_FENCE, controllerCalls: [] })
      } finally {
        db.close()
      }
    } finally {
      if (child.exitCode === null) {
        child.kill(9)
        await child.exited
      }
      if (blockedReaderPid !== undefined) {
        killProcessGroup(blockedReaderPid)
        await waitForProcessGroupExit(blockedReaderPid)
      }
      await restarted?.stop()
      await serverFixture.cleanup()
    }
  }, 25_000)
})
