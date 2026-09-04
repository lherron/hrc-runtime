import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createHrcServer } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  cliEnv,
  dbPath,
  runCli,
  serverOpts,
  setServer,
  setupCliFixture,
  teardownCliFixture,
} from './fixtures/cli.fixture.js'

beforeEach(setupCliFixture)
afterEach(teardownCliFixture)

describe('live transcript search CLI', () => {
  it('reads the resident projection through status and search RPCs', async () => {
    const db = openHrcDatabase(dbPath)
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inv-search-live',
      runtimeId: 'rt-search-live',
      seq: 1,
      time: '2026-06-01T12:00:00.000Z',
      type: 'user.message',
      payload: { content: 'old ledger nebula phrase' },
    })
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inv-search-live',
      runtimeId: 'rt-search-live',
      seq: 2,
      time: '2026-06-01T12:01:00.000Z',
      type: 'assistant.message.completed',
      payload: { content: [{ type: 'text', text: 'nebula reply' }], final: true },
    })
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'inv-search-live',
      runtimeId: 'rt-search-live',
      seq: 3,
      time: '2026-06-01T12:02:00.000Z',
      type: 'turn.completed',
      payload: {},
    })
    db.close()

    setServer(
      await createHrcServer({
        ...serverOpts(),
        hrcTranscriptIndexTickIntervalMs: 10,
      })
    )

    const status = await runCli(['index', 'status', '--json'], cliEnv())
    expect(status.exitCode).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({ turnsIndexed: 1, lagEvents: 0 })

    const search = await runCli(
      ['monitor', 'search', 'old ledger', '--target', 'rt-search-live', '--json'],
      cliEnv()
    )
    expect(search.exitCode).toBe(0)
    expect(JSON.parse(search.stdout)).toMatchObject({
      mode: 'within_runtime',
      hits: [
        { runtimeId: 'rt-search-live', invocationId: 'inv-search-live', seqFrom: 1, seqTo: 3 },
      ],
      index: { lagEvents: 0 },
    })
  })
})
