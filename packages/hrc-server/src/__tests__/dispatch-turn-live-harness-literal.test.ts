/**
 * dispatchTurn against a tmux runtime with a live interactive harness must
 * deliver the prompt via literal send-keys (mirroring the hrcchat dm path),
 * not write a launch artifact and inject `bun run exec.ts`. Without this
 * branch, the running harness CLI sees the bun command as keystrokes.
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
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

describe('dispatchTurn against live interactive harness', () => {
  it('delivers prompt via literal send-keys and writes no launch artifact', async () => {
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
    expect(turnRes.status).toBe(200)
    const turnBody = (await turnRes.json()) as {
      runtimeId: string
      transport: string
      status: string
    }
    expect(turnBody.runtimeId).toBe(runtimeId)
    expect(turnBody.transport).toBe('tmux')
    expect(turnBody.status).toBe('started')

    // No new launch artifact should be written for the literal path.
    const afterFiles = await readdir(launchesDir).catch(() => [] as string[])
    expect(afterFiles.length).toBe(beforeFiles.length)

    // The pane should contain the literal prompt (not `bun run exec.ts`).
    // tmux can hard-wrap long lines so compare against the newline-stripped
    // capture before asserting.
    let compactCapture = ''
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Bun.sleep(100)
      const captured = await tmux.capture(pane.paneId)
      compactCapture = captured.replaceAll('\n', '')
      if (compactCapture.includes('live-harness literal payload')) {
        break
      }
    }
    expect(compactCapture).toContain('live-harness literal payload')
    expect(compactCapture).not.toContain('bun run')
    expect(compactCapture).not.toContain('exec.ts')

    // turn.accepted event tags the literal delivery mode (mirrors hrcchat dm path).
    const eventsDb = openHrcDatabase(fixture.dbPath)
    try {
      const events = eventsDb.hrcEvents.listFromHrcSeq(1) as Array<{
        eventKind: string
        payload?: Record<string, unknown>
      }>
      const accepted = events.find((e) => e.eventKind === 'turn.accepted')
      expect(accepted).toBeDefined()
      expect(accepted?.payload?.['delivery']).toBe('interactive-literal')
    } finally {
      eventsDb.close()
    }
  })
})
