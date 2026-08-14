/**
 * T-07235 — bundle retention: keep-N per generation, TTL, orphan-dir removal,
 * and the new `RuntimeArtifactRepository` deletion path.
 *
 * Pruning a bundle never prunes the trip: the durable fact is observation
 * history and stays keep-forever (docs/state-retention.md).
 */
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HRC_FIRST_TURN_MISSING_BUNDLE_ARTIFACT_KIND } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { firstTurnBundleArtifactId, pruneFirstTurnMissingBundles } from '../first-turn-retention'

const HOST_SESSION_ID = 'hsid-retention'
const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-07235'
const LANE_REF = 'default'
const RUNTIME_ID = 'rt-retention'

const NOW = new Date('2026-08-14T12:00:00.000Z')

type Fixture = {
  db: ReturnType<typeof openHrcDatabase>
  dir: string
  runtimeRoot: string
  cleanup: () => Promise<void>
}

let fixture: Fixture

async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-ft-retention-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  return {
    db,
    dir,
    runtimeRoot: join(dir, 'run'),
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Seed a tripped generation with its bundle directory on disk. */
async function seedTrip(input: {
  generation: number
  tripEventSeq: number
  trippedAt: string
  linked?: boolean
}): Promise<string> {
  const bundleDir = join(
    fixture.runtimeRoot,
    'artifacts',
    RUNTIME_ID,
    'first-turn-missing',
    String(input.tripEventSeq)
  )
  await mkdir(bundleDir, { recursive: true })
  await writeFile(join(bundleDir, 'manifest.json'), '{}')

  fixture.db.firstTurnWatch.arm({
    runtimeId: RUNTIME_ID,
    generation: input.generation,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    primingDispatchedAt: input.trippedAt,
    firstTurnDeadlineAt: input.trippedAt,
  })
  fixture.db.firstTurnWatch.markTripped(
    RUNTIME_ID,
    input.generation,
    input.trippedAt,
    input.tripEventSeq
  )
  if (input.linked !== false) {
    fixture.db.firstTurnWatch.recordDiagnostics(RUNTIME_ID, input.generation, {
      bundleDir,
      diagnosticsEventSeq: input.tripEventSeq + 1,
      updatedAt: input.trippedAt,
    })
    fixture.db.runtimeArtifacts.insert({
      artifactId: firstTurnBundleArtifactId(input.tripEventSeq),
      operationId: RUNTIME_ID,
      artifactKind: HRC_FIRST_TURN_MISSING_BUNDLE_ARTIFACT_KIND,
      mediaType: 'application/json',
      storageKind: 'file-path',
      contentHash: `hash-${input.tripEventSeq}`,
      artifactPath: bundleDir,
      createdAt: input.trippedAt,
    })
  }
  return bundleDir
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('keep-N per (runtimeId, generation)', () => {
  /**
   * The durable table has ONE row per (runtimeId, generation), so in production
   * this rule is a safety net that never binds today — a generation cannot hold
   * a second tracked bundle. It is still implemented and tested exactly as
   * specified, against a store fake that can present two bundles under one key,
   * so the rule is real if that ever changes.
   */
  it('keeps the newest N bundles under one key and deletes the rest', async () => {
    const dirs: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const dir = join(
        fixture.runtimeRoot,
        'artifacts',
        RUNTIME_ID,
        'first-turn-missing',
        String(600 + index)
      )
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'manifest.json'), '{}')
      dirs.push(dir)
    }

    const records = dirs.map((bundleDir, index) => ({
      runtimeId: RUNTIME_ID,
      generation: 1,
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      firstTurnMissingTrippedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
      tripEventSeq: 600 + index,
      diagnosticsEventSeq: 700 + index,
      bundleDir,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }))

    const cleared: Array<[string, number]> = []
    const deletedArtifactIds: string[] = []
    const store = {
      firstTurnWatch: {
        listTrips: () => records,
        clearBundle: (runtimeId: string, generation: number) => {
          cleared.push([runtimeId, generation])
        },
      },
      runtimeArtifacts: {
        listByKind: () => [],
        deleteByArtifactId: (artifactId: string) => {
          deletedArtifactIds.push(artifactId)
          return true
        },
      },
    }

    const result = await pruneFirstTurnMissingBundles(store, {
      runtimeRoot: fixture.runtimeRoot,
      keepPerGeneration: 2,
      ttlDays: 3650,
      now: NOW,
      apply: true,
    })

    expect(result.scanned).toBe(4)
    expect(result.overKeepLimit).toBe(2)
    expect(result.deletedDirs).toBe(2)
    // Newest two kept (trip seq 603, 602); oldest two deleted (600, 601).
    expect(await exists(dirs[0] as string)).toBe(false)
    expect(await exists(dirs[1] as string)).toBe(false)
    expect(await exists(dirs[2] as string)).toBe(true)
    expect(await exists(dirs[3] as string)).toBe(true)
    expect(deletedArtifactIds.sort()).toEqual(['first-turn-missing-600', 'first-turn-missing-601'])
    expect(cleared).toHaveLength(2)
  })

  it('buckets by generation, so keep-1 spares one bundle per generation', async () => {
    const older = await seedTrip({
      generation: 1,
      tripEventSeq: 200,
      trippedAt: '2026-08-01T00:00:00.000Z',
    })
    const newer = await seedTrip({
      generation: 2,
      tripEventSeq: 201,
      trippedAt: '2026-08-10T00:00:00.000Z',
    })

    const result = await pruneFirstTurnMissingBundles(fixture.db, {
      runtimeRoot: fixture.runtimeRoot,
      keepPerGeneration: 1,
      ttlDays: 3650,
      now: NOW,
      apply: true,
    })

    expect(result.overKeepLimit).toBe(0)
    expect(await exists(older)).toBe(true)
    expect(await exists(newer)).toBe(true)
  })
})

describe('TTL', () => {
  it('deletes an expired bundle, its artifact row, and its pointer', async () => {
    const dir = await seedTrip({
      generation: 1,
      tripEventSeq: 300,
      trippedAt: '2026-06-01T00:00:00.000Z',
    })

    const result = await pruneFirstTurnMissingBundles(fixture.db, {
      runtimeRoot: fixture.runtimeRoot,
      keepPerGeneration: 10,
      ttlDays: 14,
      now: NOW,
      apply: true,
    })

    expect(result.expired).toBe(1)
    expect(await exists(dir)).toBe(false)
    expect(fixture.db.runtimeArtifacts.getByArtifactId(firstTurnBundleArtifactId(300))).toBeNull()
    const watch = fixture.db.firstTurnWatch.get(RUNTIME_ID, 1)
    expect(watch?.bundleDir).toBeUndefined()
    // The trip itself is observation history and survives.
    expect(watch?.firstTurnMissingTrippedAt).toBe('2026-06-01T00:00:00.000Z')
    expect(watch?.tripEventSeq).toBe(300)
  })

  it('spares a bundle inside the TTL', async () => {
    const dir = await seedTrip({
      generation: 1,
      tripEventSeq: 301,
      trippedAt: '2026-08-13T00:00:00.000Z',
    })
    const result = await pruneFirstTurnMissingBundles(fixture.db, {
      runtimeRoot: fixture.runtimeRoot,
      keepPerGeneration: 10,
      ttlDays: 14,
      now: NOW,
      apply: true,
    })
    expect(result.expired).toBe(0)
    expect(await exists(dir)).toBe(true)
  })

  it('reports without deleting when apply is false', async () => {
    const dir = await seedTrip({
      generation: 1,
      tripEventSeq: 302,
      trippedAt: '2026-06-01T00:00:00.000Z',
    })
    const result = await pruneFirstTurnMissingBundles(fixture.db, {
      runtimeRoot: fixture.runtimeRoot,
      ttlDays: 14,
      now: NOW,
      apply: false,
    })
    expect(result.expired).toBe(1)
    expect(result.deletedDirs).toBe(0)
    expect(await exists(dir)).toBe(true)
  })
})

describe('orphan directories', () => {
  it('removes a bundle dir with no linking event once past the assembly budget', async () => {
    // The write-before-link crash window: directory written, linking event
    // never emitted, so nothing references it.
    const orphan = join(fixture.runtimeRoot, 'artifacts', RUNTIME_ID, 'first-turn-missing', '999')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'manifest.json'), '{}')
    const old = new Date(NOW.getTime() - 60_000)
    await utimes(orphan, old, old)

    const result = await pruneFirstTurnMissingBundles(fixture.db, {
      runtimeRoot: fixture.runtimeRoot,
      now: NOW,
      apply: true,
    })

    expect(result.orphanDirs).toBe(1)
    expect(await exists(orphan)).toBe(false)
  })

  it('spares a directory younger than the assembly budget — assembly may be in flight', async () => {
    const fresh = join(fixture.runtimeRoot, 'artifacts', RUNTIME_ID, 'first-turn-missing', '1000')
    await mkdir(fresh, { recursive: true })
    await utimes(fresh, NOW, NOW)

    const result = await pruneFirstTurnMissingBundles(fixture.db, {
      runtimeRoot: fixture.runtimeRoot,
      now: NOW,
      apply: true,
    })
    expect(result.orphanDirs).toBe(0)
    expect(await exists(fresh)).toBe(true)
  })

  it('never touches a linked bundle', async () => {
    const dir = await seedTrip({
      generation: 1,
      tripEventSeq: 400,
      trippedAt: '2026-08-13T00:00:00.000Z',
    })
    const old = new Date(NOW.getTime() - 60_000)
    await utimes(dir, old, old)

    const result = await pruneFirstTurnMissingBundles(fixture.db, {
      runtimeRoot: fixture.runtimeRoot,
      now: NOW,
      apply: true,
    })
    expect(result.orphanDirs).toBe(0)
    expect(await exists(dir)).toBe(true)
  })

  it('is a no-op when the artifact root does not exist yet', async () => {
    const result = await pruneFirstTurnMissingBundles(fixture.db, {
      runtimeRoot: join(fixture.dir, 'never-created'),
      now: NOW,
      apply: true,
    })
    expect(result).toMatchObject({ scanned: 0, orphanDirs: 0, deletedDirs: 0, errors: [] })
  })
})

describe('RuntimeArtifactRepository deletion path', () => {
  it('deleteByArtifactId removes the row and reports whether it existed', () => {
    fixture.db.runtimeArtifacts.insert({
      artifactId: 'first-turn-missing-500',
      operationId: RUNTIME_ID,
      artifactKind: HRC_FIRST_TURN_MISSING_BUNDLE_ARTIFACT_KIND,
      mediaType: 'application/json',
      storageKind: 'file-path',
      contentHash: 'hash-500',
      artifactPath: '/tmp/nowhere',
      createdAt: NOW.toISOString(),
    })
    expect(fixture.db.runtimeArtifacts.deleteByArtifactId('first-turn-missing-500')).toBe(true)
    expect(fixture.db.runtimeArtifacts.getByArtifactId('first-turn-missing-500')).toBeNull()
    expect(fixture.db.runtimeArtifacts.deleteByArtifactId('first-turn-missing-500')).toBe(false)
  })

  it('drops artifact rows whose directory is gone', async () => {
    fixture.db.runtimeArtifacts.insert({
      artifactId: 'first-turn-missing-501',
      operationId: RUNTIME_ID,
      artifactKind: HRC_FIRST_TURN_MISSING_BUNDLE_ARTIFACT_KIND,
      mediaType: 'application/json',
      storageKind: 'file-path',
      contentHash: 'hash-501',
      artifactPath: join(fixture.runtimeRoot, 'artifacts', RUNTIME_ID, 'first-turn-missing', '501'),
      createdAt: NOW.toISOString(),
    })

    const result = await pruneFirstTurnMissingBundles(fixture.db, {
      runtimeRoot: fixture.runtimeRoot,
      now: NOW,
      apply: true,
    })
    expect(result.deletedArtifactRows).toBe(1)
    expect(fixture.db.runtimeArtifacts.getByArtifactId('first-turn-missing-501')).toBeNull()
  })
})
