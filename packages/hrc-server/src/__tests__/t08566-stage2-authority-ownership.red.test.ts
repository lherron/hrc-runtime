/** T-08566 C14/C14d: retained recovery never races live ownership. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { BrokerEventMapper } from '../broker/event-mapper'
import { type HrcServer, createHrcServer } from '../index'
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

function retainedCursor(dbPath: string, invocationId: string): number | null {
  const db = openHrcDatabase(dbPath)
  try {
    return (
      db.sqlite
        .query<{ retained_projected_through_seq: number | null }, [string]>(
          `SELECT retained_projected_through_seq
             FROM broker_invocations
            WHERE invocation_id = ?`
        )
        .get(invocationId)?.retained_projected_through_seq ?? null
    )
  } catch {
    return null
  } finally {
    db.close()
  }
}

function outcomeCount(dbPath: string, invocationId: string): number {
  const db = openHrcDatabase(dbPath)
  try {
    return (
      db.sqlite
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM retained_evidence_outcomes WHERE invocation_id = ?'
        )
        .get(invocationId)?.count ?? 0
    )
  } catch {
    return 0
  } finally {
    db.close()
  }
}

function durableOwnerRows(dbPath: string, runtimeId: string, invocationId: string): string {
  const db = openHrcDatabase(dbPath)
  try {
    return JSON.stringify({
      runtime: db.sqlite
        .query<Record<string, unknown>, [string]>('SELECT * FROM runtimes WHERE runtime_id = ?')
        .get(runtimeId),
      invocation: db.sqlite
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
  const db = openHrcDatabase(dbPath)
  try {
    return JSON.stringify(
      db.sqlite
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

async function livePathRequests(
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
      const live = await captureStderr(() => livePathRequests(serverFixture, seeded))
      expect(
        live.stderr
          .split('\n')
          .filter((line) => line.includes(seeded.runtimeId) && /attach|ackEvents/.test(line))
      ).toEqual([])
      for (const [path, response] of live.value) {
        expect({ path, status: response.status, code: await codeOf(response) }).toEqual({
          path,
          status: 409,
          code: RETAINED_FENCE,
        })
        expect(durableOwnerRows(serverFixture.dbPath, seeded.runtimeId, seeded.invocationId)).toBe(
          before
        )
      }
    } finally {
      await server?.stop()
      await serverFixture.cleanup()
    }
  })

  test('C14b control: unprojected runtimes are not refused by the retained-evidence fence', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-live-control-')
    const seeded = await seedOfflineRuntime(serverFixture, 'full')
    const server = await createHrcServer(serverFixture.serverOpts())
    try {
      for (const [path, response] of await livePathRequests(serverFixture, seeded)) {
        expect({ path, code: await codeOf(response) }).not.toEqual({ path, code: RETAINED_FENCE })
      }
    } finally {
      await server.stop()
      await serverFixture.cleanup()
    }
  })

  test('recovery-first crossing makes attach wait, then refuse after the retained commit', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-crossing-')
    const server = await createHrcServer(serverFixture.serverOpts())
    try {
      const seeded = await seedOfflineRuntime(serverFixture, 'timeout')
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
          }
        }
        const pending = [
          serverFixture.postJson('/v1/runtimes/attach', { runtimeId: seeded.runtimeId }),
          serverFixture.postJson('/v1/runtimes/adopt', { runtimeId: seeded.runtimeId }),
          serverFixture.postJson('/v1/turns', {
            hostSessionId: seeded.hostSessionId,
            prompt: 'crossing turn',
          }),
          serverFixture.postJson('/v1/messages/dm', {
            from: { kind: 'entity', entity: 'human' },
            to: { kind: 'session', sessionRef: seeded.sessionRef },
            body: 'crossing dm',
          }),
        ]
        const settled = [false, false, false, false]
        pending.forEach(
          (request, index) =>
            void request.finally(() => {
              settled[index] = true
            })
        )
        await Bun.sleep(20)
        const settledBeforeUnblock = [...settled]
        await writeFile(seeded.reader.unblockPath, '')
        const responses = await Promise.all(pending)
        return {
          readerSpawned: true,
          settledBeforeUnblock,
          settledAfterCompletion: [...settled],
          recoveryStatus: (await recovery).status,
          responses,
        }
      })
      expect(crossing.value.readerSpawned).toBe(true)
      expect(crossing.value.settledBeforeUnblock).toEqual([false, false, false, false])
      expect(crossing.value.settledAfterCompletion).toEqual([true, true, true, true])
      expect(crossing.value.recoveryStatus).toBe(200)
      for (const response of crossing.value.responses) {
        expect(response.status).toBe(409)
        expect(await codeOf(response)).toBe(RETAINED_FENCE)
      }
      expect(runtimeRow(serverFixture.dbPath, seeded.runtimeId)).toBe(beforeRuntime)
      expect(
        crossing.stderr
          .split('\n')
          .filter((line) => line.includes(seeded.runtimeId) && /attach|ackEvents/.test(line))
      ).toEqual([])
    } finally {
      await server.stop()
      await serverFixture.cleanup()
    }
  })

  test('C14d attach-first: recovery refuses without spawning, then retries after owner release', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-attach-first-')
    const seeded = await seedOfflineRuntime(serverFixture, 'full')
    const server = await createHrcServer(serverFixture.serverOpts())
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
    const unavailable = await seedOfflineRuntime(serverFixture, 'full')
    const empty = await seedOfflineRuntime(serverFixture, 'unknown-invocation')
    await Bun.$`mv ${unavailable.reader.root} ${`${unavailable.reader.root}.missing`}`.quiet()
    const server = await createHrcServer(serverFixture.serverOpts())
    try {
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
    const childCode = `
      import { createHrcServer } from './packages/hrc-server/src/index.ts'
      const options = JSON.parse(process.env.T08566_SERVER_OPTIONS)
      await createHrcServer(options)
      process.stdout.write('READY\\n')
      await new Promise(() => {})
    `
    const child = Bun.spawn(['bun', '-e', childCode], {
      cwd: process.cwd(),
      env: { ...process.env, T08566_SERVER_OPTIONS: JSON.stringify(serverFixture.serverOpts()) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let restarted: HrcServer | undefined
    try {
      const stdout = child.stdout
      if (!(stdout instanceof ReadableStream)) throw new Error('child stdout is not readable')
      const reader = stdout.getReader()
      const first = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => {
          throw new Error('child daemon did not become ready')
        }),
      ])
      reader.releaseLock()
      expect(new TextDecoder().decode(first.value)).toContain('READY')

      const recovery = serverFixture.postJson('/v1/capture/recover', {
        runtimeId: seeded.runtimeId,
        yes: true,
      })
      for (
        let attempt = 0;
        attempt < 200 && retainedCursor(serverFixture.dbPath, seeded.invocationId) === null;
        attempt += 1
      ) {
        await Bun.sleep(10)
      }
      expect(retainedCursor(serverFixture.dbPath, seeded.invocationId)).not.toBeNull()
      expect(outcomeCount(serverFixture.dbPath, seeded.invocationId)).toBe(0)

      child.kill(9)
      await child.exited
      await recovery.catch(() => undefined)
      await writeFile(seeded.reader.unblockPath, '')
      restarted = await createHrcServer(serverFixture.serverOpts())

      for (const [path, response] of (await livePathRequests(serverFixture, seeded)).filter(
        ([path]) => path !== 'dm'
      )) {
        expect({ path, status: response.status, code: await codeOf(response) }).toEqual({
          path,
          status: 409,
          code: RETAINED_FENCE,
        })
      }
      const resumed = await serverFixture.postJson('/v1/capture/recover', {
        runtimeId: seeded.runtimeId,
        yes: true,
      })
      expect(resumed.status).toBe(200)
      const recorded = JSON.parse(await readFile(seeded.reader.recordPath, 'utf8')) as {
        stdin: string
      }
      expect(JSON.parse(recorded.stdin)).toMatchObject({ afterSeq: 18 })
    } finally {
      if (child.exitCode === null) {
        child.kill(9)
        await child.exited
      }
      await restarted?.stop()
      await serverFixture.cleanup()
    }
  }, 15_000)
})
