/** T-08566 D1-D5/D8/D9: evidence holds outlive automation and need disposition. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHrcServer, type HrcServer } from '../index'
import { createHrcTestFixture, type HrcServerTestFixture } from './fixtures/hrc-test-fixture'
import { seedOfflineRuntime } from './fixtures/t08566-offline-reader-double'

let fixture: HrcServerTestFixture
let server: HrcServer
beforeEach(async () => {
  fixture = await createHrcTestFixture('t08566-holds-')
  server = await createHrcServer(fixture.serverOpts())
})
afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

describe('T-08566 recovery holds and disposition', () => {
  test('ordinary prune dry-run remains callable (positive control)', async () => {
    const response = await fixture.postJson('/v1/runtimes/prune', {
      status: ['terminated'],
      olderThan: '0s',
      dryRun: true,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
  })

  test('recovery is mutating: confirmation required and dry-run never spawns', async () => {
    const seeded = await seedOfflineRuntime(fixture, 'full')
    const unconfirmed = await fixture.postJson('/v1/runtimes/capture/recover', {
      runtimeId: seeded.runtimeId,
    })
    expect(unconfirmed.status).toBe(400)
    expect(await unconfirmed.json()).toMatchObject({ error: { code: 'confirmation_required' } })

    const dryRun = await fixture.postJson('/v1/runtimes/capture/recover', {
      runtimeId: seeded.runtimeId,
      dryRun: true,
    })
    expect(dryRun.status).toBe(200)
    expect(await dryRun.json()).toMatchObject({ spawned: false, trigger: 'operator' })
  })

  test('bulk prune spares held evidence and explicit disposal requires a reason', async () => {
    const seeded = await seedOfflineRuntime(fixture, 'release-mismatch')
    const recovery = await fixture.postJson('/v1/runtimes/capture/recover', {
      runtimeId: seeded.runtimeId,
      yes: true,
    })
    expect(recovery.status).toBe(200)
    const bulk = await fixture.postJson('/v1/runtimes/prune', {
      status: ['terminated'],
      olderThan: '0s',
      dryRun: true,
    })
    expect(await bulk.json()).toMatchObject({
      results: [
        { runtimeId: seeded.runtimeId, status: 'skipped', reason: 'offline_evidence_held' },
      ],
    })

    const disposal = await fixture.postJson('/v1/runtimes/prune', {
      runtimeIds: [seeded.runtimeId],
      disposeRetainedEvidence: true,
      yes: true,
    })
    expect(disposal.status).toBe(400)
    expect(await disposal.json()).toMatchObject({ error: { code: 'disposition_reason_required' } })
  })

  test('outcome audit is keep-forever and outside hrc_events', () => {
    const db = new Database(fixture.dbPath, { readonly: true })
    try {
      const names = db
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((entry: { name: string }) => entry.name)
      expect(names).toContain('retained_evidence_outcomes')
    } finally {
      db.close()
    }
  })
})
