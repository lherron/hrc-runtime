/** T-08566 C16/C17/C18/C21: bounded paging, progress and resumable slices. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHrcServer, type HrcServer } from '../index'
import { createHrcTestFixture, type HrcServerTestFixture } from './fixtures/hrc-test-fixture'
import {
  type ReaderMode,
  seedOfflineRuntime,
} from './fixtures/t08566-offline-reader-double'

let fixture: HrcServerTestFixture
let server: HrcServer
beforeEach(async () => {
  fixture = await createHrcTestFixture('t08566-pages-')
  server = await createHrcServer(fixture.serverOpts())
})
afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

async function recoverRuntime(runtimeId: string) {
  const response = await fixture.postJson('/v1/runtimes/capture/recover', {
    runtimeId,
    yes: true,
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text.trimStart().startsWith('{')
      ? (JSON.parse(text) as Record<string, unknown>)
      : { raw: text },
  }
}

async function attempt(mode: ReaderMode) {
  const seeded = await seedOfflineRuntime(fixture, mode)
  return recoverRuntime(seeded.runtimeId)
}

describe('T-08566 paging and work slices', () => {
  test('bounded event stream remains live (positive control)', async () => {
    expect((await fixture.fetchSocket('/v1/events?after=0')).status).toBe(200)
  })

  test('nonprogressing hasMore page is a contract violation', async () => {
    const observed = await attempt('nonprogress')
    expect(observed.status).toBe(200)
    expect(observed.body).toMatchObject({ outcome: 'reader_contract_violation', held: true })
  })

  test('snapshot change stops after the last wholly validated page', async () => {
    const observed = await attempt('snapshot-change')
    expect(observed.status).toBe(200)
    expect(observed.body).toMatchObject({ outcome: 'ledger_snapshot_unstable', class: 'retryable' })
  })

  test('slice checkpoint is in_progress without consuming retry budget, then resumes', async () => {
    await server.stop()
    server = await createHrcServer(
      fixture.serverOpts({ offlineEvidenceSliceMaxPages: 3 } as never)
    )
    const seeded = await seedOfflineRuntime(fixture, 'small-bytes')
    const first = await recoverRuntime(seeded.runtimeId)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ outcome: 'in_progress', attempts: 0, held: true })
    const second = await recoverRuntime(seeded.runtimeId)
    expect(second.body).toMatchObject({ outcome: 'recovered', class: 'complete' })
  })
})
