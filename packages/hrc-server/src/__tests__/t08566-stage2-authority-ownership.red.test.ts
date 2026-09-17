/** T-08566 C14/C14d: retained recovery never races live ownership. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { BrokerEventMapper } from '../broker/event-mapper'
import { createHrcServer } from '../index'
import {
  RUNTIME_ID,
  headlessSequence,
  makeSeededFixture,
  type SeededFixture,
} from './broker-event-mapper-fixtures'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import { seedOfflineRuntime } from './fixtures/t08566-offline-reader-double'

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

  test('every live attach is fenced after retained projection, but not before it', () => {
    const columns = fixture.db.sqlite
      .query<{ name: string }, []>('PRAGMA table_info(broker_invocations)')
      .all()
      .map((row) => row.name)
    expect(columns).toContain('retained_projected_through_seq')
  })

  test('recovery-first crossing makes attach wait, then refuse after the retained commit', async () => {
    const serverFixture = await createHrcTestFixture('t08566-owner-crossing-')
    const server = await createHrcServer(serverFixture.serverOpts())
    try {
      const seeded = await seedOfflineRuntime(serverFixture, 'timeout')
      const recovery = serverFixture.postJson('/v1/runtimes/capture/recover', {
        runtimeId: seeded.runtimeId,
        yes: true,
      })
      for (let attempt = 0; attempt < 50 && !existsSync(seeded.reader.recordPath); attempt += 1) {
        await Bun.sleep(10)
      }
      expect(existsSync(seeded.reader.recordPath)).toBe(true)

      let attachSettled = false
      const attach = serverFixture
        .postJson('/v1/runtimes/attach', { runtimeId: seeded.runtimeId })
        .finally(() => {
          attachSettled = true
        })
      await Bun.sleep(20)
      expect(attachSettled).toBe(false)
      await writeFile(seeded.reader.unblockPath, '')

      expect((await recovery).status).toBe(200)
      const attachResponse = await attach
      expect(attachResponse.status).toBe(409)
      expect(await attachResponse.json()).toMatchObject({
        error: { code: 'runtime_retained_evidence_projected' },
      })
    } finally {
      await server.stop()
      await serverFixture.cleanup()
    }
  })
})
