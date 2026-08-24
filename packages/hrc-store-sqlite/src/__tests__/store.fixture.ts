/**
 * RED/GREEN tests for hrc-store-sqlite (T-00953 / T-00951)
 *
 * Tests the public surface of openHrcDatabase():
 *   - Fresh migration applies Phase 1 schema
 *   - CRUD for each repository (continuities, sessions, runtimes, runs, launches, events, surface_bindings, runtime_buffers)
 *   - Monotonic event seq ordering
 *   - JSON round-trip for intent/continuation/tmux_json
 *   - Concurrent read safety with WAL mode
 *
 * Pass conditions for Larry (T-00951):
 *   1. openHrcDatabase(path) returns HrcDatabase with all 7 repositories
 *   2. migrations.applied contains at least one migration name
 *   3. Each repository supports the CRUD operations tested below
 *   4. EventRepository.append assigns monotonically increasing seq
 *   5. JSON fields (lastAppliedIntentJson, continuation, tmuxJson) survive round-trip
 *   6. WAL mode is enabled (PRAGMA journal_mode returns 'wal')
 */
import { afterEach, beforeEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type {
  HrcContinuationRef,
  HrcEventEnvelope,
  HrcLaunchRecord,
  HrcRunRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
export { HrcErrorCode } from 'hrc-core'
// This import is the RED gate — it will fail until Larry implements the module
export { openHrcDatabase } from '../index'

export function ts(): string {
  return new Date().toISOString()
}

export function testScopeRef(scopeKey: string): string {
  return `agent:test:project:hrc-store:task:${scopeKey}`
}

export function testSessionRef(scopeKey: string, laneRef = 'default'): string {
  return `${testScopeRef(scopeKey)}/lane:${laneRef}`
}

export function createStoreTestFixture(): { readonly dbPath: string } {
  let tmpDir = ''
  let dbPath = ''

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-store-test-'))
    dbPath = join(tmpDir, 'test.sqlite')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  return {
    get dbPath() {
      return dbPath
    },
  }
}

// ---------------------------------------------------------------------------
// 1. Migration & database factory
// ---------------------------------------------------------------------------
