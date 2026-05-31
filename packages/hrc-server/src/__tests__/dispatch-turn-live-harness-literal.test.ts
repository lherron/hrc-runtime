/**
 * dispatchTurn against a legacy tmux runtime with a live interactive harness
 * must not deliver harness input via literal send-keys. The broker cutover
 * stales the legacy runtime and fails closed if a broker cannot be started.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { TmuxManager } from '../tmux'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-dispatch-literal-')
  server = await createHrcServer(fixture.serverOpts({ claudeCodeTmuxBrokerEnabled: true }))
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

describe('dispatchTurn against live interactive harness', () => {
  it('does not literal-deliver into a live non-broker tmux runtime', async () => {
    const tmux = new TmuxManager(fixture.tmuxSocketPath)
    await tmux.initialize()

    const scopeRef = 'agent:clod-live-harness:project:agent-spaces'
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')

    const runtimeId = `rt-live-${randomUUID()}`
    const launchId = `launch-live-${randomUUID()}`
    const timestamp = fixture.now()

    const seedDb = openHrcDatabase(fixture.dbPath)
    try {
      seedDb.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        tmuxJson: pane,
        launchId,
        supportsInflightInput: false,
        adopted: false,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      seedDb.launches.insert({
        launchId,
        hostSessionId,
        generation,
        runtimeId,
        harness: 'claude-code',
        provider: 'anthropic',
        launchArtifactPath: '/tmp/fake-existing-launch.json',
        status: 'child_started',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      seedDb.close()
    }

    const launchesDir = join(fixture.runtimeRoot, 'launches')
    const beforeFiles = await readdir(launchesDir).catch(() => [] as string[])

    const turnRes = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'live-harness literal payload',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: {
          provider: 'anthropic',
          interactive: true,
        },
        execution: {
          preferredMode: 'interactive',
        },
      },
    })
    expect(turnRes.status).toBe(503)
    const turnBody = (await turnRes.json()) as {
      error?: { code?: string; message?: string }
    }
    expect(turnBody.error?.code).toBe('runtime_unavailable')

    // No legacy launch artifact should be written.
    const afterFiles = await readdir(launchesDir).catch(() => [] as string[])
    expect(afterFiles.length).toBe(beforeFiles.length)

    const captured = await tmux.capture(pane.paneId)
    const compactCapture = captured.replaceAll('\n', '')
    expect(compactCapture).not.toContain('live-harness literal payload')
    expect(compactCapture).not.toContain('bun run')
    expect(compactCapture).not.toContain('exec.ts')

    const eventsDb = openHrcDatabase(fixture.dbPath)
    try {
      expect(eventsDb.runtimes.getByRuntimeId(runtimeId)?.status).toBe('stale')
      const events = eventsDb.hrcEvents.listFromHrcSeq(1) as Array<{
        eventKind: string
        payload?: Record<string, unknown>
      }>
      expect(events.some((e) => e.eventKind === 'turn.accepted')).toBe(false)
      expect(events.some((e) => e.eventKind === 'runtime.stale')).toBe(true)
    } finally {
      eventsDb.close()
    }
  })
})
