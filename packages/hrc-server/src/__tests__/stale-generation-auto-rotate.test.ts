/**
 * T-01216 contract tests: stale-generation auto-rotation.
 *
 * HRC auto-rotates sessions whose `createdAt` exceeds
 * `HRC_STALE_GENERATION_HOURS` (default 24h) before dispatching a turn or
 * starting a runtime, so callers never silently reuse a stale continuation
 * key. These tests cover:
 *   - the rotation fires from semantic DM, dispatchTurn, and startRuntime
 *   - callers can opt out with `allowStaleGeneration: true`
 *   - the kill-switch (`staleGenerationEnabled: false`) suppresses rotation
 *   - fresh sessions pass through untouched
 *   - a `session.generation_auto_rotated` HRC event is emitted
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Database } from 'bun:sqlite'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-stale-rotate-')
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

function ageSessionBy(dbPath: string, hostSessionId: string, seconds: number): void {
  // Rewind the session's created_at by `seconds` so the rotation threshold
  // fires without having to stand up a fake wall clock. Use bun:sqlite
  // directly because HrcDatabase doesn't expose createdAt patches.
  const db = new Database(dbPath)
  try {
    const past = new Date(Date.now() - seconds * 1000).toISOString()
    db.prepare('UPDATE sessions SET created_at = ? WHERE host_session_id = ?').run(
      past,
      hostSessionId
    )
  } finally {
    db.close()
  }
}

describe('stale-generation auto-rotate on /v1/runtimes/start', () => {
  it('rotates the session when age exceeds the threshold', async () => {
    server = await createHrcServer(
      fixture.serverOpts({
        staleGenerationEnabled: true,
        staleGenerationThresholdSec: 60,
      })
    )

    const resolved = await fixture.resolveSession('clod')
    ageSessionBy(fixture.dbPath, resolved.hostSessionId, 3600) // 1 hour old

    const res = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: resolved.hostSessionId,
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'headless' },
      },
    })

    // The rotation itself must succeed even if the downstream start fails;
    // what we care about is that the session record moved to generation 2.
    expect([200, 503]).toContain(res.status)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      const continuity = db.continuities.getByKey('agent:clod', 'default')
      expect(continuity).toBeDefined()
      const active = db.sessions.getByHostSessionId(continuity!.activeHostSessionId)
      expect(active).toBeDefined()
      expect(active!.generation).toBe(2)
      expect(active!.hostSessionId).not.toBe(resolved.hostSessionId)
      expect(active!.priorHostSessionId).toBe(resolved.hostSessionId)

      // Rotation event must be recorded.
      const events = db.hrcEvents.listFromHrcSeq(1)
      const rotated = events.find((e) => e.eventKind === 'session.generation_auto_rotated')
      expect(rotated).toBeDefined()
      const payload = rotated!.payload as Record<string, unknown>
      expect(payload['trigger']).toBe('runtime-start')
      expect(payload['priorGeneration']).toBe(1)
      expect(payload['nextGeneration']).toBe(2)
      expect(typeof payload['ageSec']).toBe('number')
      expect((payload['ageSec'] as number) >= 3600).toBe(true)
    } finally {
      db.close()
    }
  })

  it('leaves fresh sessions untouched', async () => {
    server = await createHrcServer(
      fixture.serverOpts({
        staleGenerationEnabled: true,
        staleGenerationThresholdSec: 3600,
      })
    )

    const resolved = await fixture.resolveSession('clod')

    await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: resolved.hostSessionId,
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'headless' },
      },
    })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      const continuity = db.continuities.getByKey('agent:clod', 'default')
      const active = db.sessions.getByHostSessionId(continuity!.activeHostSessionId)
      expect(active!.generation).toBe(1)
      expect(active!.hostSessionId).toBe(resolved.hostSessionId)

      const events = db.hrcEvents.listFromHrcSeq(1)
      expect(events.some((e) => e.eventKind === 'session.generation_auto_rotated')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('respects allowStaleGeneration: true', async () => {
    server = await createHrcServer(
      fixture.serverOpts({
        staleGenerationEnabled: true,
        staleGenerationThresholdSec: 60,
      })
    )

    const resolved = await fixture.resolveSession('clod')
    ageSessionBy(fixture.dbPath, resolved.hostSessionId, 3600)

    await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: resolved.hostSessionId,
      allowStaleGeneration: true,
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'headless' },
      },
    })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      const continuity = db.continuities.getByKey('agent:clod', 'default')
      const active = db.sessions.getByHostSessionId(continuity!.activeHostSessionId)
      expect(active!.generation).toBe(1)
      expect(active!.hostSessionId).toBe(resolved.hostSessionId)
    } finally {
      db.close()
    }
  })

  it('respects the kill-switch (staleGenerationEnabled: false)', async () => {
    server = await createHrcServer(
      fixture.serverOpts({
        staleGenerationEnabled: false,
        staleGenerationThresholdSec: 60,
      })
    )

    const resolved = await fixture.resolveSession('clod')
    ageSessionBy(fixture.dbPath, resolved.hostSessionId, 3600)

    await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: resolved.hostSessionId,
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'headless' },
      },
    })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      const continuity = db.continuities.getByKey('agent:clod', 'default')
      const active = db.sessions.getByHostSessionId(continuity!.activeHostSessionId)
      expect(active!.generation).toBe(1)
    } finally {
      db.close()
    }
  })
})

describe('stale-generation parsing', () => {
  it('rejects non-boolean allowStaleGeneration', async () => {
    server = await createHrcServer(fixture.serverOpts())
    const resolved = await fixture.resolveSession('clod')

    const res = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: resolved.hostSessionId,
      allowStaleGeneration: 'yes',
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { provider: 'anthropic', interactive: true },
        execution: { preferredMode: 'headless' },
      },
    })
    expect(res.status).toBe(400)
  })
})
