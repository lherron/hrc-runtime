/**
 * T-08566 stage-1 behavior reds: retire producer-less launch ingest without
 * disturbing Desktop registration, retained history, or broker projection.
 *
 * These tests deliberately drive the public Unix-socket HTTP surface and the
 * real spool reader. The Stop case has no launch row or launch artifact: the
 * legacy route currently accepts an unknown launch id and can terminalize an
 * accepted broker run, which is the defect this stage retires.
 *
 * Expected pre-implementation red signal:
 * - hook and launch callbacks do not return the named 410 response;
 * - an OTLP listener is still exposed and bound;
 * - retired spool entries are applied/deleted instead of quarantined.
 *
 * Positive controls remain green throughout: Desktop registration/spooling and
 * the committed broker-event projection path are intentionally not retired.
 */
import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { BrokerEventMapper } from '../broker/event-mapper'
import { appendHrcEvent } from '../hrc-event-helper'
import { createHrcServer } from '../index'
import { CORRUPT_SPOOL_DIRNAME, readSpoolEntries, spoolCallback } from '../launch/spool'
import { RUN_ID, headlessSequence, makeSeededFixture } from './broker-event-mapper-fixtures'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'

const RETIRED_CODE = 'legacy_launch_ingest_retired'

type SequenceSnapshot = {
  count: number
  maxSeq: number | null
}

type DurableSnapshot = {
  events: SequenceSnapshot
  hrcEvents: SequenceSnapshot
  launches: number
  runs: number
  runtimes: number
}

function sequenceSnapshot(
  db: HrcDatabase,
  table: 'events' | 'hrc_events',
  sequenceColumn: 'seq' | 'hrc_seq'
): SequenceSnapshot {
  const row = db.sqlite
    .query<{ count: number; maxSeq: number | null }, []>(
      `SELECT COUNT(*) AS count, MAX(${sequenceColumn}) AS maxSeq FROM ${table}`
    )
    .get()
  return { count: row?.count ?? 0, maxSeq: row?.maxSeq ?? null }
}

function durableSnapshot(db: HrcDatabase): DurableSnapshot {
  const count = (table: 'launches' | 'runs' | 'runtimes'): number =>
    db.sqlite.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ??
    0
  return {
    events: sequenceSnapshot(db, 'events', 'seq'),
    hrcEvents: sequenceSnapshot(db, 'hrc_events', 'hrc_seq'),
    launches: count('launches'),
    runs: count('runs'),
    runtimes: count('runtimes'),
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function listOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
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

function retiredWarnLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => line.includes('WARN server.legacy_launch_ingest_refused'))
}

async function unusedTcpPort(): Promise<number> {
  const listener = createTcpServer()
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const address = listener.address()
  if (address === null || typeof address === 'string') {
    listener.close()
    throw new Error('failed to reserve an ephemeral TCP port')
  }
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}

test('R1: unknown-launch Stop is refused without mutating an accepted broker run', async () => {
  const fixture = await createHrcTestFixture('t08566-hook-retired-')
  const server = await createHrcServer(fixture.serverOpts({ otelPreferredPort: 0 } as never))
  const scopeRef = 'agent:smokey:project:hrc-runtime:task:T-08566'
  const hostSessionId = `hsid-${randomUUID()}`
  const runtimeId = `rt-${randomUUID()}`
  const runId = `run-${randomUUID()}`
  const launchId = `unknown-${randomUUID()}`

  try {
    fixture.seedSession(hostSessionId, scopeRef)
    fixture.seedTmuxRuntime(hostSessionId, scopeRef, runtimeId, {
      status: 'busy',
      activeRunId: runId,
    })
    const seeded = openHrcDatabase(fixture.dbPath)
    let before: DurableSnapshot
    try {
      seeded.runtimes.update(runtimeId, {
        controllerKind: 'harness-broker',
        updatedAt: fixture.now(),
      })
      seeded.runs.insert({
        runId,
        hostSessionId,
        runtimeId,
        scopeRef,
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        status: 'accepted',
        acceptedAt: fixture.now(),
        updatedAt: fixture.now(),
      })
      before = durableSnapshot(seeded)
    } finally {
      seeded.close()
    }

    const { value: response, stderr } = await captureStderr(() =>
      fixture.postJson('/v1/internal/hooks/ingest', {
        launchId,
        hostSessionId,
        generation: 1,
        runtimeId,
        hookData: { hook_event_name: 'Stop' },
      })
    )
    const body = (await response.json()) as { error?: { code?: string; route?: string } }

    const observed = openHrcDatabase(fixture.dbPath)
    try {
      expect(response.status).toBe(410)
      expect(body).toMatchObject({
        error: { code: RETIRED_CODE, route: '/v1/internal/hooks/ingest' },
      })
      expect(retiredWarnLines(stderr)).toHaveLength(1)
      expect(retiredWarnLines(stderr)[0]).toContain('"route":"/v1/internal/hooks/ingest"')
      expect(durableSnapshot(observed)).toEqual(before)
      expect(observed.runs.getByRunId(runId)).toMatchObject({
        status: 'accepted',
        completedAt: undefined,
      })
      expect(observed.runtimes.getByRuntimeId(runtimeId)).toMatchObject({
        status: 'busy',
        activeRunId: runId,
        controllerKind: 'harness-broker',
      })
    } finally {
      observed.close()
    }
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

const launchCallbackCases = [
  {
    callback: 'wrapper-started',
    body: (hostSessionId: string) => ({ hostSessionId, wrapperPid: 91001 }),
  },
  {
    callback: 'child-started',
    body: (hostSessionId: string) => ({ hostSessionId, childPid: 91002 }),
  },
  {
    callback: 'continuation',
    body: (hostSessionId: string) => ({
      hostSessionId,
      continuation: { provider: 'anthropic', key: 'session-retired' },
    }),
  },
  {
    callback: 'event',
    body: (hostSessionId: string) => ({
      hostSessionId,
      type: 'notice',
      message: 'legacy callback must not be accepted',
    }),
  },
  {
    callback: 'exited',
    body: (hostSessionId: string) => ({ hostSessionId, exitCode: 0 }),
  },
] as const

for (const callbackCase of launchCallbackCases) {
  test(`R2: ${callbackCase.callback} callback returns the named 410 and writes nothing`, async () => {
    const fixture = await createHrcTestFixture(`t08566-${callbackCase.callback}-`)
    const server = await createHrcServer(fixture.serverOpts({ otelPreferredPort: 0 } as never))
    const scopeRef = 'agent:smokey:project:hrc-runtime:task:T-08566'
    const hostSessionId = `hsid-${randomUUID()}`
    const launchId = `launch-${randomUUID()}`
    const route = `/v1/internal/launches/${launchId}/${callbackCase.callback}`

    try {
      fixture.seedSession(hostSessionId, scopeRef)
      const beforeDb = openHrcDatabase(fixture.dbPath)
      let before: DurableSnapshot
      try {
        before = durableSnapshot(beforeDb)
      } finally {
        beforeDb.close()
      }

      const { value: response, stderr } = await captureStderr(() =>
        fixture.postJson(route, callbackCase.body(hostSessionId))
      )
      const responseText = await response.text()
      let body: unknown
      try {
        body = JSON.parse(responseText)
      } catch {
        body = responseText
      }

      const observed = openHrcDatabase(fixture.dbPath)
      try {
        expect(response.status).toBe(410)
        expect(body).toMatchObject({ error: { code: RETIRED_CODE, route } })
        expect(retiredWarnLines(stderr)).toHaveLength(1)
        expect(retiredWarnLines(stderr)[0]).toContain(`"route":"${route}"`)
        expect(durableSnapshot(observed)).toEqual(before)
        expect(observed.launches.getByLaunchId(launchId)).toBeNull()
      } finally {
        observed.close()
      }
    } finally {
      await server.stop()
      await fixture.cleanup()
    }
  })
}

test('R3: the daemon exposes no OTLP endpoint and leaves the configured legacy port unbound', async () => {
  const fixture = await createHrcTestFixture('t08566-otlp-retired-')
  const port = await unusedTcpPort()
  const server = await createHrcServer(fixture.serverOpts({ otelPreferredPort: port } as never))
  try {
    expect((server as unknown as { otelEndpoint?: string }).otelEndpoint).toBeUndefined()
    await expect(
      fetch(`http://127.0.0.1:${port}/v1/logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).rejects.toThrow()
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('R4: retired spool entries are quarantined while Desktop bytes, reader, and history survive', async () => {
  const fixture = await createHrcTestFixture('t08566-spool-retired-')
  let server = await createHrcServer(fixture.serverOpts({ otelPreferredPort: 0 } as never))
  const runtime = await fixture.ensureRuntime('agent:smokey:project:hrc-runtime:task:T-08566')
  const hookKey = `hook-${randomUUID()}`
  const launchKey = `launch-${randomUUID()}`
  const desktopKey = `desktop-${randomUUID()}`
  const historicalLaunchId = `historical-${randomUUID()}`

  try {
    const seeded = openHrcDatabase(fixture.dbPath)
    let before: DurableSnapshot
    try {
      const session = seeded.sessions.getByHostSessionId(runtime.hostSessionId)
      if (!session) throw new Error('fixture session is missing')
      seeded.launches.insert({
        launchId: historicalLaunchId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        harness: 'claude-code',
        provider: 'anthropic',
        launchArtifactPath: '',
        status: 'exited',
        createdAt: fixture.now(),
        updatedAt: fixture.now(),
      })
      seeded.events.append({
        ts: fixture.now(),
        hostSessionId: runtime.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        source: 'hook',
        eventKind: 'historical.hook',
        eventJson: { retained: true },
      })
      appendHrcEvent(seeded, 'launch.wrapper_started', {
        ts: fixture.now(),
        hostSessionId: runtime.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        launchId: historicalLaunchId,
        payload: { wrapperPid: 8080 },
      })
      before = durableSnapshot(seeded)
    } finally {
      seeded.close()
    }

    await server.stop()

    const hookPath = await spoolCallback(fixture.spoolDir, hookKey, {
      endpoint: '/v1/internal/hooks/ingest',
      payload: {
        launchId: hookKey,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        hookData: { kind: 'turn.started' },
      },
    })
    const launchRoute = `/v1/internal/launches/${launchKey}/wrapper-started`
    const launchPath = await spoolCallback(fixture.spoolDir, launchKey, {
      endpoint: launchRoute,
      payload: { hostSessionId: runtime.hostSessionId, wrapperPid: 91919 },
    })
    const desktopPath = await spoolCallback(fixture.spoolDir, desktopKey, {
      endpoint: '/v1/internal/desktop/register',
      payload: { nativeThreadId: randomUUID() },
    })
    const desktopBytesBefore = await readFile(desktopPath)
    expect(
      (await readSpoolEntries(fixture.spoolDir, desktopKey)).map((entry) => entry.payload)
    ).toEqual([
      {
        endpoint: '/v1/internal/desktop/register',
        payload: expect.objectContaining({ nativeThreadId: expect.any(String) }),
      },
    ])

    const started = await captureStderr(() =>
      createHrcServer(fixture.serverOpts({ otelPreferredPort: 0 } as never))
    )
    server = started.value

    expect(await Bun.file(hookPath).exists()).toBe(false)
    expect(await Bun.file(launchPath).exists()).toBe(false)
    expect(await listOrEmpty(join(fixture.spoolDir, CORRUPT_SPOOL_DIRNAME, hookKey))).toHaveLength(
      1
    )
    expect(
      await listOrEmpty(join(fixture.spoolDir, CORRUPT_SPOOL_DIRNAME, launchKey))
    ).toHaveLength(1)
    expect(started.stderr.match(/retired legacy spool entry quarantined/g) ?? []).toHaveLength(2)
    expect(started.stderr).toContain('/v1/internal/hooks/ingest')
    expect(started.stderr).toContain(launchRoute)

    expect(await Bun.file(desktopPath).exists()).toBe(true)
    expect(sha256(await readFile(desktopPath))).toBe(sha256(desktopBytesBefore))
    expect(await readSpoolEntries(fixture.spoolDir, desktopKey)).toHaveLength(1)
    expect(started.stderr).toContain('spool replay failed')
    expect(started.stderr).toContain('/v1/internal/desktop/register')

    const observed = openHrcDatabase(fixture.dbPath)
    try {
      expect(durableSnapshot(observed)).toEqual(before)
      expect(observed.events.listFromSeq(1)).toEqual([
        expect.objectContaining({ source: 'hook', eventKind: 'historical.hook' }),
      ])
      expect(observed.hrcEvents.listByLaunch(historicalLaunchId)).toEqual([
        expect.objectContaining({ eventKind: 'launch.wrapper_started' }),
      ])
      expect(observed.launches.getByLaunchId(historicalLaunchId)).not.toBeNull()
      expect(observed.launches.getByLaunchId(launchKey)).toBeNull()
      expect(observed.runtimes.getByRuntimeId(runtime.runtimeId)).toMatchObject({ status: 'ready' })
    } finally {
      observed.close()
    }
  } finally {
    await server.stop().catch(() => {})
    await fixture.cleanup()
  }
})

test('R5 positive control: Desktop registration keeps its 200 pending contract', async () => {
  const fixture = await createHrcTestFixture('t08566-desktop-control-')
  const server = await createHrcServer(fixture.serverOpts({ otelPreferredPort: 0 } as never))
  try {
    const response = await fixture.postJson('/v1/internal/desktop/register', {
      nativeThreadId: randomUUID(),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'pending',
      reason: 'native_metadata_unavailable',
      detail: 'no rollout path reported; registration needs native session metadata',
    })
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('R6 positive control: committed broker evidence still projects a complete turn', async () => {
  const fixture = await makeSeededFixture()
  try {
    const mapper = new BrokerEventMapper({ db: fixture.db })
    for (const event of headlessSequence()) mapper.apply(event)

    const projectedKinds = fixture.db.hrcEvents.listFromHrcSeq(1).map((event) => event.eventKind)
    expect(projectedKinds).toEqual(
      expect.arrayContaining([
        'turn.accepted',
        'turn.started',
        'turn.message',
        'turn.tool_result',
        'turn.completed',
      ])
    )
    expect(fixture.db.runs.getByRunId(RUN_ID)).toMatchObject({ status: 'completed' })
    expect(fixture.db.events.listFromSeq(1)).toEqual([])
  } finally {
    await fixture.cleanup()
  }
})
