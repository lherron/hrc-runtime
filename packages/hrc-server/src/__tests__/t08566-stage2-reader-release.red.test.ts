/** T-08566 C1/C5/C6/C19/C22: exact-release reader admission and failures. */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { type HrcServer, createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'
import {
  type ReaderMode,
  makeOfflineReaderDouble,
  seedOfflineRuntime,
} from './fixtures/t08566-offline-reader-double'

let fixture: HrcServerTestFixture
let server: HrcServer
beforeEach(async () => {
  fixture = await createHrcTestFixture('t08566-reader-')
  server = await createHrcServer(fixture.serverOpts())
})
afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

function openReadProbe(): Database {
  const db = new Database(fixture.dbPath, { readonly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

function executionRelease(runtimeId: string): Record<string, unknown> | undefined {
  const db = openReadProbe()
  try {
    const row = db
      .query<{ runtime_state_json: string | null }, [string]>(
        'SELECT runtime_state_json FROM runtimes WHERE runtime_id = ?'
      )
      .get(runtimeId)
    if (!row?.runtime_state_json) return undefined
    return (JSON.parse(row.runtime_state_json) as Record<string, unknown>)['executionRelease'] as
      | Record<string, unknown>
      | undefined
  } finally {
    db.close()
  }
}

async function invokeReaderDouble(mode: ReaderMode, afterSeq: number) {
  const invocationId = `inv-double-audit-${mode}`
  const reader = await makeOfflineReaderDouble(fixture.tmpDir, mode, {
    releaseId: `asp-double-audit-${mode}`,
  })
  const request = {
    schema: 'harness-broker.offline-evidence/v1',
    operation: 'eventsSince',
    invocationId,
    afterSeq,
    limit: 500,
    maxBytes: 4 * 1024 * 1024,
  }
  const proc = Bun.spawn([reader.executable, 'evidence-read', '--event-ledger', '/ledger'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  })
  proc.stdin.write(JSON.stringify(request))
  proc.stdin.end()
  const [stdout, stderr, exitCode, persistedRelease] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
    readFile(`${reader.root}/release.json`, 'utf8').then(
      (text) => JSON.parse(text) as Record<string, unknown>
    ),
  ])
  return {
    invocationId,
    reader,
    exitCode,
    stderr,
    response: JSON.parse(stdout) as Record<string, unknown>,
    persistedRelease,
  }
}

describe('T-08566 exact immutable reader release', () => {
  test('reader double conforms across every non-malformed response mode', async () => {
    const allModes: ReaderMode[] = [
      'full',
      'small-bytes',
      'unknown-invocation',
      'after-beyond-current',
      'release-mismatch',
      'nonprogress',
      'snapshot-change',
      'overflow',
      'exit-one',
      'timeout',
      'block-page-two',
      'torn',
      'corrupt',
      'duplicate',
      'oversize',
      'below-floor',
    ]
    const deliberatelyMalformedModes = new Set<ReaderMode>([
      'release-mismatch',
      'nonprogress',
      'snapshot-change', // Its deliberately invalid behavior is on page 2.
      'overflow',
      'exit-one',
      'timeout',
    ])
    for (const mode of allModes) {
      if (deliberatelyMalformedModes.has(mode)) continue
      const afterSeq = mode === 'unknown-invocation' ? 7 : mode === 'after-beyond-current' ? 100 : 0
      const observed = await invokeReaderDouble(mode, afterSeq)
      const ok = observed.response['ok']
      expect({ mode, exitCode: observed.exitCode, stderr: observed.stderr }).toEqual({
        mode,
        exitCode: ok === false ? 2 : 0,
        stderr: '',
      })
      expect(observed.persistedRelease['capabilities']).toContain(
        'harness-broker.offline-evidence/v1'
      )
      const persistedIdentity = {
        releaseId: observed.persistedRelease['releaseId'],
        sourceCommit: observed.persistedRelease['sourceCommit'],
        builtAt: observed.persistedRelease['builtAt'],
      }
      expect(observed.response['release']).toEqual(persistedIdentity)

      if (ok === false) {
        expect((observed.response['error'] as { code?: unknown })?.code).toBeString()
        continue
      }

      const result = observed.response['result'] as {
        currentSeq: number
        events: Array<{ invocationId: string; seq: number }>
      }
      expect(result.events.map((event) => event.invocationId)).toEqual(
        result.events.map(() => observed.invocationId)
      )
      const integrity = observed.response['integrity'] as
        | { lastIntact?: { invocationId?: string } }
        | undefined
      if (integrity?.lastIntact) {
        expect(integrity.lastIntact.invocationId).toBe(observed.invocationId)
      }
      expect(result.events.map((event) => event.seq)).toEqual(
        result.events.map((_, index) => afterSeq + index + 1)
      )
      const expectedNextAfterSeq = result.events.at(-1)?.seq ?? afterSeq
      expect(observed.response['nextAfterSeq']).toBe(expectedNextAfterSeq)
      expect(observed.response['hasMore']).toBe(expectedNextAfterSeq < result.currentSeq)
      expect(Number(observed.response['nextAfterSeq'])).toBeGreaterThanOrEqual(afterSeq)
    }

    const mismatch = await invokeReaderDouble('release-mismatch', 0)
    expect(mismatch.response['release']).toEqual({
      releaseId: 'asp-derived-mismatch',
      sourceCommit: mismatch.persistedRelease['sourceCommit'],
      builtAt: mismatch.persistedRelease['builtAt'],
    })
    expect((mismatch.response['release'] as { releaseId: string }).releaseId).not.toBe(
      mismatch.persistedRelease['releaseId']
    )
  })

  test('two seeded readers own distinct releases and cannot overwrite or remove each other', async () => {
    const intact = await seedOfflineRuntime(fixture, 'full')
    const typedError = await seedOfflineRuntime(fixture, 'corrupt')
    const intactManifest = JSON.parse(
      await readFile(`${intact.reader.root}/release.json`, 'utf8')
    ) as Record<string, unknown>
    const typedManifest = JSON.parse(
      await readFile(`${typedError.reader.root}/release.json`, 'utf8')
    ) as Record<string, unknown>
    const intactResponse = JSON.parse(
      await readFile(`${intact.reader.root}/response.json`, 'utf8')
    ) as Record<string, unknown>
    const typedResponseText = await readFile(`${typedError.reader.root}/response.json`, 'utf8')
    const typedResponse = JSON.parse(typedResponseText) as Record<string, unknown>
    const intactBinding = executionRelease(intact.runtimeId)
    const typedBinding = executionRelease(typedError.runtimeId)
    for (const observed of [
      { manifest: intactManifest, binding: intactBinding, response: intactResponse },
      { manifest: typedManifest, binding: typedBinding, response: typedResponse },
    ]) {
      const identity = {
        releaseId: observed.manifest['releaseId'],
        sourceCommit: observed.manifest['sourceCommit'],
        builtAt: observed.manifest['builtAt'],
      }
      expect(observed.binding).toMatchObject(identity)
      expect(observed.response['release']).toEqual(identity)
    }
    expect(intact.reader.root).not.toBe(typedError.reader.root)
    expect(intactManifest['releaseId']).not.toBe(typedManifest['releaseId'])
    expect(intactResponse).toMatchObject({ ok: true })
    expect(typedResponse).toMatchObject({ ok: false, error: { code: 'ledger_corrupt' } })

    await rm(intact.reader.root, { recursive: true, force: true })
    expect(existsSync(typedError.reader.executable)).toBe(true)
    expect(await readFile(`${typedError.reader.root}/response.json`, 'utf8')).toBe(
      typedResponseText
    )
  })

  test('compiled-response reader double executes and records the real invocation seam', async () => {
    const reader = await makeOfflineReaderDouble(fixture.tmpDir, 'full')
    const proc = Bun.spawn([reader.executable, 'evidence-read', '--event-ledger', '/ledger'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    })
    proc.stdin.write(
      JSON.stringify({
        schema: 'harness-broker.offline-evidence/v1',
        operation: 'eventsSince',
        invocationId: 'inv-positive-control',
        afterSeq: 0,
        limit: 500,
        maxBytes: 4 * 1024 * 1024,
      })
    )
    proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    const response = JSON.parse(stdout) as { ok: boolean; result: { events: unknown[] } }
    expect(response.ok).toBe(true)
    expect(response.result.events.length).toBeGreaterThan(0)
    const record = JSON.parse(await readFile(reader.recordPath, 'utf8')) as {
      argv: string[]
      stdin: string
    }
    expect(record.argv).toEqual(['evidence-read', '--event-ledger', '/ledger'])
    expect(JSON.parse(record.stdin)).toMatchObject({ invocationId: 'inv-positive-control' })
  })

  test('existing lifecycle event HTTP surface is live (positive control)', async () => {
    const response = await fixture.fetchSocket('/v1/events?after=0')
    expect(response.status).toBe(200)
  })

  for (const [_mode, _outcome] of [
    ['release-mismatch', 'reader_release_mismatch'],
    ['overflow', 'reader_contract_violation'],
    ['corrupt', 'ledger_corrupt'],
    ['duplicate', 'ledger_conflicting_duplicate'],
    ['oversize', 'offline_record_too_large'],
    ['below-floor', 'replay_below_floor'],
  ] as const) {
  }
})
