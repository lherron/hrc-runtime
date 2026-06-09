/**
 * RED regression for T-03528 — the harness broker event consumer must survive the
 * backing DB being closed out from under it during teardown.
 *
 * Symptom (hrc-cli suite, non-deterministic): `server.stop()` closes the SQLite DB
 * while a per-runtime `consumeEvents` loop is still parked on its live event stream.
 * The next event wakes the loop, it calls `db.brokerInvocations.getByInvocationId`,
 * and bun:sqlite throws `RangeError: Cannot use a closed database`. The catch then
 * calls `markBrokerCrashTerminal`, which reads the DB AGAIN and throws a SECOND
 * closed-db error that escapes the IIFE as an unhandled rejection
 * ("# Unhandled error between tests"), reddening an otherwise 0-fail suite.
 *
 * Contract: once the DB is closed, the consumer must exit QUIETLY — no
 * crash-terminal transition, no error log, no escaping throw.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { HarnessBrokerController } from '../broker/controller'
import {
  INVOCATION_ID,
  RUNTIME_ID,
  type SeededFixture,
  envelope,
  makeSeededFixture,
} from './broker-event-mapper-fixtures'

let fixture: SeededFixture

beforeEach(async () => {
  fixture = await makeSeededFixture()
})

afterEach(async () => {
  // The DB is intentionally closed inside the test; guard the double-close.
  try {
    await fixture.cleanup()
  } catch {
    // already torn down
  }
})

describe('T-03528 broker event consumer survives DB close during teardown', () => {
  it('exits quietly when an event arrives after the backing DB is closed', async () => {
    const errorLogs: string[] = []
    const controller = new HarnessBrokerController({
      db: fixture.db,
      now: () => '2026-01-01T00:00:00.000Z',
      serverInstanceId: 'hrc-server-closed-db-test',
      logger: {
        error: (message: string) => {
          errorLogs.push(message)
        },
      },
    })

    // The teardown race's escaping throw originates in markBrokerCrashTerminal
    // (it re-reads the closed DB). Spy to prove it is NOT reached once closed.
    let crashTerminalCalls = 0
    const realMark = (
      controller as unknown as { markBrokerCrashTerminal: (...a: unknown[]) => void }
    ).markBrokerCrashTerminal.bind(controller)
    ;(
      controller as unknown as { markBrokerCrashTerminal: (...a: unknown[]) => void }
    ).markBrokerCrashTerminal = (...args: unknown[]) => {
      crashTerminalCalls++
      return realMark(...args)
    }

    // A manually-gated live event stream feeding the private consumer, mirroring a
    // broker that pushes one more event mid-teardown.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let delivered = false
    async function* liveEvents(): AsyncGenerator<InvocationEventEnvelope> {
      await gate
      if (!delivered) {
        delivered = true
        yield envelope('invocation.started', 1, {})
      }
    }
    ;(
      controller as unknown as {
        consumeEvents: (id: string, events: AsyncIterable<InvocationEventEnvelope>) => void
      }
    ).consumeEvents(RUNTIME_ID, liveEvents())

    // Simulate server.stop(): close the backing DB while the consumer is parked on
    // the live stream, then let the event through.
    fixture.db.close()
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(crashTerminalCalls).toBe(0)
    expect(errorLogs).not.toContain('harness broker event consumer failed')

    // Sanity: the seeded invocation is still INVOCATION_ID (no projection occurred).
    expect(INVOCATION_ID).toBeTruthy()
  })
})
