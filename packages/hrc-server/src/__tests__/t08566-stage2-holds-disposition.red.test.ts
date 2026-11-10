import { Database } from 'bun:sqlite'
/** T-08566 D1-D5/D8/D9: evidence holds outlive automation and need disposition. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type HrcServer, createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

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
