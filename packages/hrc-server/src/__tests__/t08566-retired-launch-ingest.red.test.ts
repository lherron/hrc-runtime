/**
 * Retired native ingest routes stay unmatched and cannot mutate broker runs.
 * Committed broker projection remains supported.
 */
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createServer as createTcpServer } from 'node:net'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { BrokerEventMapper } from '../broker/event-mapper'
import { createHrcServer } from '../index'
import { RUN_ID, headlessSequence, makeSeededFixture } from './broker-event-mapper-fixtures'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import { type ServerLogCapture, withServerLog } from './fixtures/server-log'

type SequenceSnapshot = {
  count: number
  maxSeq: number | null
}

type DurableSnapshot = {
  hrcEvents: SequenceSnapshot
  runs: number
  runtimes: number
}

function sequenceSnapshot(
  db: HrcDatabase,
  table: 'hrc_events',
  sequenceColumn: 'hrc_seq'
): SequenceSnapshot {
  const row = db.sqlite
    .query<{ count: number; maxSeq: number | null }, []>(
      `SELECT COUNT(*) AS count, MAX(${sequenceColumn}) AS maxSeq FROM ${table}`
    )
    .get()
  return { count: row?.count ?? 0, maxSeq: row?.maxSeq ?? null }
}

function durableSnapshot(db: HrcDatabase): DurableSnapshot {
  const count = (table: 'runs' | 'runtimes'): number =>
    db.sqlite.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ??
    0
  return {
    hrcEvents: sequenceSnapshot(db, 'hrc_events', 'hrc_seq'),
    runs: count('runs'),
    runtimes: count('runtimes'),
  }
}

function retiredWarnLines(log: ServerLogCapture): string[] {
  return log
    .events('server.legacy_launch_ingest_refused')
    .filter((line) => line.level === 'warn')
    .map((line) => JSON.stringify(line))
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

    const { value: response, log } = await withServerLog(() =>
      fixture.postJson('/v1/internal/hooks/ingest', {
        launchId,
        hostSessionId,
        generation: 1,
        runtimeId,
        hookData: { hook_event_name: 'Stop' },
      })
    )
    const body = await response.text()

    const observed = openHrcDatabase(fixture.dbPath)
    try {
      expect(response.status).toBe(404)
      expect(body).toBe('Not Found')
      expect(retiredWarnLines(log)).toHaveLength(0)
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
  test(`R2: ${callbackCase.callback} callback is unmatched and writes nothing`, async () => {
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

      const { value: response, log } = await withServerLog(() =>
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
        expect(response.status).toBe(404)
        expect(body).toBe('Not Found')
        expect(retiredWarnLines(log)).toHaveLength(0)
        expect(durableSnapshot(observed)).toEqual(before)
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

test('R5 refusal control: retired Desktop registration answers 404 (T-08567)', async () => {
  const fixture = await createHrcTestFixture('t08566-desktop-control-')
  const server = await createHrcServer(fixture.serverOpts({ otelPreferredPort: 0 } as never))
  try {
    const response = await fixture.postJson('/v1/internal/desktop/register', {
      nativeThreadId: randomUUID(),
    })
    expect(response.status).toBe(404)
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
    expect(
      fixture.db.sqlite.query("SELECT name FROM sqlite_master WHERE name = 'events'").all()
    ).toEqual([])
  } finally {
    await fixture.cleanup()
  }
})
