import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { HarnessBrokerController } from '../broker/controller'
import { BrokerEventMapper } from '../broker/event-mapper'
import {
  INVOCATION_ID,
  RUNTIME_ID,
  type SeededFixture,
  envelope,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

type LogRecord = {
  message: string
  fields?: Record<string, unknown>
}

const fixtures: SeededFixture[] = []
const controllers: HarnessBrokerController[] = []
const writers: Database[] = []

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.shutdown()
  }
  for (const writer of writers.splice(0)) {
    try {
      writer.exec('ROLLBACK')
    } catch {
      // The test may already have released the writer transaction.
    }
    writer.close()
  }
  for (const fixture of fixtures.splice(0)) {
    await fixture.cleanup()
  }
})

function diagnostic(seq = 1): InvocationEventEnvelope {
  return envelope('diagnostic', seq, {
    level: 'info',
    message: `busy-policy event ${seq}`,
  })
}

async function* eventStream(
  events: InvocationEventEnvelope[]
): AsyncGenerator<InvocationEventEnvelope> {
  yield* events
}

function consume(
  controller: HarnessBrokerController,
  runtimeId: string,
  events: InvocationEventEnvelope[]
): void {
  ;(
    controller as unknown as {
      consumeEvents: (runtimeId: string, events: AsyncIterable<InvocationEventEnvelope>) => void
    }
  ).consumeEvents(runtimeId, eventStream(events))
}

function bindActive(controller: HarnessBrokerController): void {
  ;(
    controller as unknown as {
      active: Map<
        string,
        {
          runtimeId: string
          invocationId: string
          client: object
          closing: boolean
        }
      >
    }
  ).active.set(RUNTIME_ID, {
    runtimeId: RUNTIME_ID,
    invocationId: INVOCATION_ID,
    client: {},
    closing: false,
  })
}

function isActive(controller: HarnessBrokerController): boolean {
  return (
    controller as unknown as {
      active: Map<string, unknown>
    }
  ).active.has(RUNTIME_ID)
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error(message)
}

async function setup(windowMs: number): Promise<{
  fixture: SeededFixture
  controller: HarnessBrokerController
  writer: Database
  logs: { warn: LogRecord[]; error: LogRecord[] }
}> {
  const fixture = await makeSeededFixture()
  fixtures.push(fixture)

  // Keep the test fast and deterministic: the daemon connection surfaces the
  // writer collision immediately, leaving the controller policy to decide
  // whether the runtime survives. Production retains its bounded busy_timeout.
  fixture.db.sqlite.exec('PRAGMA busy_timeout = 0')

  const writer = new Database(fixture.dbPath)
  writers.push(writer)
  writer.exec('PRAGMA busy_timeout = 0')
  writer.exec('BEGIN IMMEDIATE')

  const logs = { warn: [] as LogRecord[], error: [] as LogRecord[] }
  const controller = new HarnessBrokerController({
    db: fixture.db,
    mapper: new BrokerEventMapper({ db: fixture.db, now: () => ts(100) }),
    now: () => ts(100),
    env: {
      HRC_BROKER_DB_BUSY_RETRY_WINDOW_MS: String(windowMs),
      HRC_BROKER_DB_BUSY_RETRY_BASE_DELAY_MS: '5',
    },
    logger: {
      warn(message, fields) {
        logs.warn.push({ message, fields })
      },
      error(message, fields) {
        logs.error.push({ message, fields })
      },
    },
  })
  controllers.push(controller)
  return { fixture, controller, writer, logs }
}

describe('T-07051 daemon SQLITE_BUSY policy', () => {
  it('keeps the consumer attached and projects the same envelope after a transient writer lock', async () => {
    const { fixture, controller, writer, logs } = await setup(250)
    bindActive(controller)

    consume(controller, RUNTIME_ID, [diagnostic()])
    await Bun.sleep(30)
    writer.exec('COMMIT')

    await waitFor(
      () => fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 1) !== null,
      1_500,
      'broker envelope was not projected after the writer released its lock'
    )
    // The pre-fix controller schedules crash bookkeeping one second after the
    // first BUSY. Wait past that boundary so this proves survival, not merely a
    // race against the old condemnation timer.
    await Bun.sleep(1_100)

    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).not.toBe('crashed')
    expect(isActive(controller)).toBeTrue()
    expect(fixture.db.brokerInvocations.getByInvocationId(INVOCATION_ID)?.lastEventSeq).toBe(1)
    expect(logs.error.map((entry) => entry.message)).not.toContain(
      'harness broker event consumer failed'
    )
  })

  it('still condemns the runtime after contention outlives the sustained-failure window', async () => {
    const { fixture, controller, writer, logs } = await setup(50)

    consume(controller, RUNTIME_ID, [diagnostic()])
    await Bun.sleep(75)
    writer.exec('COMMIT')

    await waitFor(
      () => fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status === 'crashed',
      1_500,
      'runtime was not condemned after the sustained BUSY window'
    )

    expect(fixture.db.brokerInvocationEvents.getByInvocationAndSeq(INVOCATION_ID, 1)).toBeNull()
    expect(logs.error.map((entry) => entry.message)).toContain(
      'harness broker event consumer failed'
    )
  })
})
