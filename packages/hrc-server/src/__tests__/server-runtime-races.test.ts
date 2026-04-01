/**
 * RED/GREEN tests for hrc-server runtime race findings M-5 through M-8 (T-00980)
 *
 * Tests the server's race condition and failure path coverage:
 *   - M-5: Failed tmux dispatch must not leave runtime stuck busy
 *   - M-6: Terminate must finalize active run; exited callback must not resurrect terminated runtime
 *   - M-7: Bridge registration must not reuse stale binding after session rotation
 *   - M-8: Watch follow mode must not lose events during subscription handoff
 *
 * Pass conditions for Larry (T-00980):
 *   M-5:
 *     1. If writeLaunchArtifact or tmux.sendKeys throws after runtime is set
 *        to busy, the runtime status must be rolled back to "ready" (not stuck "busy")
 *     2. The accepted run must be finalized with status "failed" (not left as "accepted")
 *     3. The 500 response must include the failure context
 *     4. A subsequent dispatch to the same runtime must succeed (runtime is not stuck)
 *
 *   M-6:
 *     5. POST /v1/terminate must finalize the active run (status "cancelled" or "terminated")
 *     6. POST /v1/terminate must clear activeRunId on the runtime
 *     7. POST /v1/internal/launches/:launchId/exited after terminate must NOT flip
 *        runtime status back to "ready" — it must remain "terminated"
 *     8. The exited callback for a terminated launch should either be rejected or
 *        silently ignored without state mutation
 *
 *   M-7:
 *     9. Bridge registration with matching (transport, target) but different
 *        hostSessionId must NOT return the stale bridge — it must create a new one
 *    10. Bridge registration with matching (transport, target) but different
 *        runtimeId must NOT return the stale bridge — it must rebind
 *    11. After session rotation (clear-context), bridge re-registration must
 *        produce a bridge bound to the new active session
 *
 *   M-8:
 *    12. Events appended between the snapshot query and subscriber registration
 *        must be delivered to the follow stream (no gap)
 *    13. The follow stream must deliver events in monotonic seq order without duplicates
 *    14. A burst of events during subscription setup must all appear in the stream
 *
 * Reference: HRC_CODE_REVIEW.md M-5, M-6, M-7, M-8
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcHttpError } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer, HrcServerOptions } from '../index'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string

function ts(): string {
  return new Date().toISOString()
}

async function fetchSocket(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    // @ts-expect-error -- Bun supports unix option on fetch
    unix: socketPath,
  })
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetchSocket(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

async function collectFollowStream(responsePromise: Promise<Response>): Promise<string> {
  let text = ''
  try {
    const response = await responsePromise
    const reader = response.body?.getReader()
    if (!reader) {
      return text
    }

    const decoder = new TextDecoder()
    while (true) {
      const chunk = await reader.read().catch(() => null)
      if (!chunk || chunk.done) {
        break
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } catch {
    // Abort is expected in follow-mode tests.
  }

  return text
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-runtime-races-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })
})

afterEach(async () => {
  try {
    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited
  } catch {
    // fine when no tmux server exists
  }
  await rm(tmpDir, { recursive: true, force: true })
})

function serverOpts(overrides: Partial<HrcServerOptions> = {}): HrcServerOptions {
  return {
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    tmuxSocketPath,
    ...overrides,
  }
}

/**
 * Seed a session + tmux runtime that is in "ready" state with a real tmux pane.
 * Returns identifiers needed for dispatch/terminate tests.
 */
async function seedReadyTmuxRuntime(
  db: HrcDatabase,
  opts?: { scopeRef?: string; generation?: number }
): Promise<{
  hostSessionId: string
  runtimeId: string
  scopeRef: string
  generation: number
  launchId: string
  tmuxSessionName: string
}> {
  const now = ts()
  const scopeRef = opts?.scopeRef ?? `project:race-${randomUUID().slice(0, 8)}`
  const hostSessionId = `hsid-${randomUUID()}`
  const runtimeId = `rt-${randomUUID()}`
  const launchId = `launch-${randomUUID()}`
  const generation = opts?.generation ?? 1
  const tmuxSessionName = `hrc-test-${runtimeId.slice(0, 8)}`

  db.continuities.upsert({
    scopeRef,
    laneRef: 'default',
    activeHostSessionId: hostSessionId,
    updatedAt: now,
  })

  db.sessions.create({
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation,
    status: 'active',
    ancestorScopeRefs: [],
    createdAt: now,
    updatedAt: now,
  })

  db.runtimes.create({
    runtimeId,
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation,
    launchId,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    tmuxJson: {
      socketPath: tmuxSocketPath,
      sessionName: tmuxSessionName,
      sessionId: '$99',
      windowId: '@0',
      paneId: '%0',
    },
    createdAt: now,
    updatedAt: now,
  })

  return { hostSessionId, runtimeId, scopeRef, generation, launchId, tmuxSessionName }
}

/**
 * Seed a runtime in "busy" state with an active accepted run — simulates
 * a dispatch that has been accepted but hasn't completed yet.
 * Creates a real tmux session so terminate/interrupt handlers work.
 */
async function seedBusyRuntime(
  db: HrcDatabase,
  opts?: { scopeRef?: string }
): Promise<{
  hostSessionId: string
  runtimeId: string
  runId: string
  launchId: string
  scopeRef: string
  tmuxSessionName: string
}> {
  const now = ts()
  const scopeRef = opts?.scopeRef ?? `project:busy-${randomUUID().slice(0, 8)}`
  const hostSessionId = `hsid-${randomUUID()}`
  const runtimeId = `rt-${randomUUID()}`
  const runId = `run-${randomUUID()}`
  const launchId = `launch-${randomUUID()}`
  const tmuxSessionName = `hrc-m6-${runtimeId.slice(0, 8)}`

  // Create a real tmux session so terminate handler can kill it
  const tmuxProc = Bun.spawn(
    ['tmux', '-S', tmuxSocketPath, 'new-session', '-d', '-s', tmuxSessionName],
    { stdout: 'ignore', stderr: 'ignore' }
  )
  await tmuxProc.exited

  // Get the real tmux IDs
  const listProc = Bun.spawn(
    [
      'tmux',
      '-S',
      tmuxSocketPath,
      'list-panes',
      '-t',
      tmuxSessionName,
      '-F',
      '#{session_id} #{window_id} #{pane_id}',
    ],
    { stdout: 'pipe', stderr: 'ignore' }
  )
  const tmuxOutput = await new Response(listProc.stdout).text()
  await listProc.exited
  const [sessionId, windowId, paneId] = tmuxOutput.trim().split(' ')

  db.continuities.upsert({
    scopeRef,
    laneRef: 'default',
    activeHostSessionId: hostSessionId,
    updatedAt: now,
  })

  db.sessions.create({
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    status: 'active',
    ancestorScopeRefs: [],
    createdAt: now,
    updatedAt: now,
  })

  db.runtimes.create({
    runtimeId,
    hostSessionId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    launchId,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'busy',
    activeRunId: runId,
    supportsInflightInput: false,
    adopted: false,
    tmuxJson: {
      socketPath: tmuxSocketPath,
      sessionName: tmuxSessionName,
      sessionId: sessionId || '$99',
      windowId: windowId || '@0',
      paneId: paneId || '%0',
    },
    createdAt: now,
    updatedAt: now,
  })

  db.runs.create({
    runId,
    hostSessionId,
    runtimeId,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    transport: 'tmux',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
  })

  db.launches.create({
    launchId,
    hostSessionId,
    generation: 1,
    runtimeId,
    harness: 'claude-code',
    provider: 'anthropic',
    launchArtifactPath: '/tmp/fake.json',
    tmuxJson: {
      socketPath: tmuxSocketPath,
      sessionName: tmuxSessionName,
      sessionId: sessionId || '$99',
      windowId: windowId || '@0',
      paneId: paneId || '%0',
    },
    status: 'accepted',
    createdAt: now,
    updatedAt: now,
  })

  return { hostSessionId, runtimeId, runId, launchId, scopeRef, tmuxSessionName }
}

// ===========================================================================
// M-5: Failed tmux dispatch leaves runtime stuck busy
// ===========================================================================
describe('M-5: failed tmux dispatch rollback', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('rolls back runtime to ready when dispatch fails mid-flight', async () => {
    // Start server with a tmux socket that does NOT have a real tmux server —
    // tmux.sendKeys will fail because no tmux session exists for the pane.
    server = await createHrcServer(serverOpts())
    const db = openHrcDatabase(dbPath)
    const seed = await seedReadyTmuxRuntime(db)

    // Attempt a dispatch turn — this should fail because tmux pane %0 doesn't exist
    const res = await postJson('/v1/turns', {
      hostSessionId: seed.hostSessionId,
      prompt: 'test dispatch that will fail',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { interactive: true, harness: 'claude-code' },
        provider: { provider: 'anthropic' },
      },
    })

    // The dispatch should return a 500 (sendKeys failure)
    expect(res.status).toBeGreaterThanOrEqual(400)

    // RED GATE: After the failure, runtime must NOT be stuck as "busy".
    // Current bug: runtime stays busy, accepted run is never cleaned up.
    const runtime = db.runtimes.getByRuntimeId(seed.runtimeId)
    expect(runtime).not.toBeNull()
    expect(runtime!.status).toBe('ready') // RED: currently stays 'busy'
  })

  it('finalizes the accepted run as failed when dispatch errors', async () => {
    server = await createHrcServer(serverOpts())
    const db = openHrcDatabase(dbPath)
    const seed = await seedReadyTmuxRuntime(db)

    await postJson('/v1/turns', {
      hostSessionId: seed.hostSessionId,
      prompt: 'test dispatch that will fail',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { interactive: true, harness: 'claude-code' },
        provider: { provider: 'anthropic' },
      },
    })

    // RED GATE: The run that was created as "accepted" must be finalized as "failed"
    const runs = db.runs.findByRuntime(seed.runtimeId)
    const acceptedRuns = runs.filter((r) => r.status === 'accepted')
    const failedRuns = runs.filter((r) => r.status === 'failed')

    expect(acceptedRuns.length).toBe(0) // RED: accepted run is never cleaned up
    expect(failedRuns.length).toBeGreaterThanOrEqual(1)
  })

  it('allows a subsequent dispatch after a failed one', async () => {
    server = await createHrcServer(serverOpts())
    const db = openHrcDatabase(dbPath)
    const seed = await seedReadyTmuxRuntime(db)

    // First dispatch fails
    await postJson('/v1/turns', {
      hostSessionId: seed.hostSessionId,
      prompt: 'first dispatch fails',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { interactive: true, harness: 'claude-code' },
        provider: { provider: 'anthropic' },
      },
    })

    // RED GATE: Second dispatch to same runtime should NOT get RUNTIME_BUSY
    // because the first dispatch was rolled back.
    const res2 = await postJson('/v1/turns', {
      hostSessionId: seed.hostSessionId,
      prompt: 'second dispatch should not be blocked',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: { interactive: true, harness: 'claude-code' },
        provider: { provider: 'anthropic' },
      },
    })

    // Should not be 409 RUNTIME_BUSY — may still be 500 (tmux down) but NOT 409
    if (res2.status === 409) {
      const body = (await res2.json()) as HrcHttpError
      expect(body.error?.code).not.toBe('runtime_busy') // RED: currently 409 runtime_busy
    }
  })
})

// ===========================================================================
// M-6: Terminate doesn't finalize active run — exited callback can resurrect
// ===========================================================================
describe('M-6: terminate finalizes run, exited ignores terminated', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('terminate finalizes the active run', async () => {
    server = await createHrcServer(serverOpts())
    const db = openHrcDatabase(dbPath)
    const seed = await seedBusyRuntime(db)

    const res = await postJson('/v1/terminate', { runtimeId: seed.runtimeId })
    expect(res.status).toBe(200)

    // RED GATE: The active run must be finalized — not left as "accepted"
    const run = db.runs.getByRunId(seed.runId)
    expect(run).not.toBeNull()
    expect(run!.status).not.toBe('accepted') // RED: currently stays 'accepted'
    expect(run!.status).toMatch(/cancelled|terminated|failed/)
  })

  it('terminate clears activeRunId on the runtime', async () => {
    server = await createHrcServer(serverOpts())
    const db = openHrcDatabase(dbPath)
    const seed = await seedBusyRuntime(db)

    await postJson('/v1/terminate', { runtimeId: seed.runtimeId })

    // RED GATE: activeRunId must be cleared after terminate
    const runtime = db.runtimes.getByRuntimeId(seed.runtimeId)
    expect(runtime).not.toBeNull()
    expect(runtime!.activeRunId).toBeUndefined() // RED: currently still set
  })

  it('exited callback does NOT resurrect a terminated runtime', async () => {
    server = await createHrcServer(serverOpts())
    const db = openHrcDatabase(dbPath)
    const seed = await seedBusyRuntime(db)

    // Terminate the runtime
    await postJson('/v1/terminate', { runtimeId: seed.runtimeId })

    // Simulate the exited callback arriving after terminate
    const _exitedRes = await postJson(`/v1/internal/launches/${seed.launchId}/exited`, {
      hostSessionId: seed.hostSessionId,
      exitCode: 0,
    })

    // The exited callback should be rejected or accepted without resurrection
    const runtime = db.runtimes.getByRuntimeId(seed.runtimeId)
    expect(runtime).not.toBeNull()

    // RED GATE: Runtime must stay "terminated", NOT flip back to "ready"
    expect(runtime!.status).toBe('terminated') // RED: currently flips to 'ready'
  })

  it('exited callback for terminated launch does not create a new ready runtime', async () => {
    server = await createHrcServer(serverOpts())
    const db = openHrcDatabase(dbPath)
    const seed = await seedBusyRuntime(db)

    // Terminate
    await postJson('/v1/terminate', { runtimeId: seed.runtimeId })

    // Exited arrives late
    await postJson(`/v1/internal/launches/${seed.launchId}/exited`, {
      hostSessionId: seed.hostSessionId,
      exitCode: 0,
    })

    // RED GATE: There should be no "ready" runtime after terminate + exited
    const runtimes = db.runtimes.findByHostSession(seed.hostSessionId)
    const readyRuntimes = runtimes.filter((r) => r.status === 'ready')
    expect(readyRuntimes.length).toBe(0) // RED: exited flips terminated → ready
  })
})

// ===========================================================================
// M-7: Bridge registration reuses stale binding after session rotation
// ===========================================================================
describe('M-7: bridge registration stale binding reuse', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('does not return stale bridge when hostSessionId has changed', async () => {
    server = await createHrcServer(serverOpts())

    // Create first session
    const res1 = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:bridge-test/lane:default',
    })
    const session1 = (await res1.json()) as { hostSessionId: string; generation: number }

    // Register a bridge for session 1
    const bridgeRes1 = await postJson('/v1/bridges/local-target', {
      hostSessionId: session1.hostSessionId,
      transport: 'agentchat',
      target: 'agent@project',
    })
    expect(bridgeRes1.status).toBe(200)
    const bridge1 = (await bridgeRes1.json()) as { bridgeId: string; hostSessionId: string }
    expect(bridge1.hostSessionId).toBe(session1.hostSessionId)

    // Rotate session via clear-context
    const clearRes = await postJson('/v1/clear-context', {
      hostSessionId: session1.hostSessionId,
    })
    expect(clearRes.status).toBe(200)
    const cleared = (await clearRes.json()) as { hostSessionId: string }
    const newHostSessionId = cleared.hostSessionId

    // Register a bridge with the SAME (transport, target) but new session
    const bridgeRes2 = await postJson('/v1/bridges/local-target', {
      hostSessionId: newHostSessionId,
      transport: 'agentchat',
      target: 'agent@project',
    })
    expect(bridgeRes2.status).toBe(200)
    const bridge2 = (await bridgeRes2.json()) as { bridgeId: string; hostSessionId: string }

    // RED GATE: Must NOT return the old bridge — must be a new one bound to new session
    expect(bridge2.hostSessionId).toBe(newHostSessionId) // RED: returns stale session1 bridge
    expect(bridge2.bridgeId).not.toBe(bridge1.bridgeId) // RED: same bridgeId returned
  })

  it('does not return stale bridge when runtimeId has changed', async () => {
    server = await createHrcServer(serverOpts())
    const db = openHrcDatabase(dbPath)

    // Create session with two runtimes
    const res1 = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:bridge-rt-test/lane:default',
    })
    const session = (await res1.json()) as { hostSessionId: string; generation: number }

    const now = ts()
    const rt1 = `rt-${randomUUID()}`
    const rt2 = `rt-${randomUUID()}`

    db.runtimes.create({
      runtimeId: rt1,
      hostSessionId: session.hostSessionId,
      scopeRef: 'project:bridge-rt-test',
      laneRef: 'default',
      generation: session.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })

    db.runtimes.create({
      runtimeId: rt2,
      hostSessionId: session.hostSessionId,
      scopeRef: 'project:bridge-rt-test',
      laneRef: 'default',
      generation: session.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })

    // Register bridge with runtime 1
    const bridgeRes1 = await postJson('/v1/bridges/local-target', {
      hostSessionId: session.hostSessionId,
      runtimeId: rt1,
      transport: 'agentchat',
      target: 'agent2@project',
    })
    expect(bridgeRes1.status).toBe(200)
    const _bridge1 = (await bridgeRes1.json()) as { bridgeId: string; runtimeId?: string }

    // Register same (transport, target) but with a DIFFERENT runtimeId
    const bridgeRes2 = await postJson('/v1/bridges/local-target', {
      hostSessionId: session.hostSessionId,
      runtimeId: rt2,
      transport: 'agentchat',
      target: 'agent2@project',
    })
    expect(bridgeRes2.status).toBe(200)
    const bridge2 = (await bridgeRes2.json()) as { bridgeId: string; runtimeId?: string }

    // RED GATE: Must NOT return old bridge bound to rt1 — must rebind to rt2
    expect(bridge2.runtimeId).toBe(rt2) // RED: returns bridge bound to rt1
  })
})

// ===========================================================================
// M-8: Watch follow mode loses events during subscription handoff
// ===========================================================================
describe('M-8: watch follow event loss during handoff', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('does not lose events appended between snapshot and subscriber registration', async () => {
    server = await createHrcServer(serverOpts())

    // Create a session so we can generate events
    const resolveRes = await postJson('/v1/sessions/resolve', {
      sessionRef: 'project:watch-race/lane:default',
    })
    const session = (await resolveRes.json()) as { hostSessionId: string; generation: number }

    // Get current seq from non-follow query
    const baseRes = await fetchSocket('/v1/events')
    const baseText = await baseRes.text()
    const baseEvents = baseText.trim().length > 0 ? parseNdjson(baseText) : []
    const baseSeq = baseEvents.length > 0 ? Number(baseEvents[baseEvents.length - 1].seq) : 0

    // Start a follow stream from the current seq
    const controller = new AbortController()
    const followPromise = fetchSocket(`/v1/events?follow=true&fromSeq=${baseSeq + 1}`, {
      signal: controller.signal,
    })

    const internals = server as HrcServer & {
      db: HrcDatabase
      notifyEvent(event: Record<string, unknown>): void
    }
    const originalListFromSeq = internals.db.events.listFromSeq.bind(internals.db.events)
    let injected = false
    internals.db.events.listFromSeq = ((fromSeq, filters) => {
      const snapshot = originalListFromSeq(fromSeq, filters)
      if (!injected) {
        injected = true
        const event = internals.db.events.append({
          ts: ts(),
          hostSessionId: session.hostSessionId,
          scopeRef: 'project:watch-race',
          laneRef: 'default',
          generation: session.generation,
          source: 'hrc',
          eventKind: 'watch.handoff.injected',
          eventJson: {
            marker: 'handoff-gap',
          },
        })
        internals.notifyEvent(event)
      }
      return snapshot
    }) as typeof internals.db.events.listFromSeq
    const followResponse = await followPromise
    const followCapture = collectFollowStream(Promise.resolve(followResponse))

    // Give the follow stream time to collect events
    await new Promise((r) => setTimeout(r, 200))

    // Abort the follow stream to collect results
    controller.abort()
    const followText = await followCapture
    internals.db.events.listFromSeq = originalListFromSeq

    const followEvents = followText.trim().length > 0 ? parseNdjson(followText) : []

    // Get the authoritative list of events from a non-follow query
    const authRes = await fetchSocket(`/v1/events?fromSeq=${baseSeq + 1}`)
    const authText = await authRes.text()
    const authEvents = authText.trim().length > 0 ? parseNdjson(authText) : []

    // RED GATE: follow stream must contain ALL events that the auth query shows.
    // Current bug: events between snapshot and subscriber registration are lost.
    const followSeqs = new Set(followEvents.map((e) => Number(e.seq)))
    const missedEvents = authEvents.filter((e) => !followSeqs.has(Number(e.seq)))

    expect(missedEvents.length).toBe(0) // RED: events lost during handoff gap
  })

  it('delivers events in monotonic seq order without duplicates', async () => {
    server = await createHrcServer(serverOpts())

    // Seed some events
    for (let i = 0; i < 3; i++) {
      await postJson('/v1/sessions/resolve', {
        sessionRef: `project:mono-${i}/lane:default`,
      })
    }

    // Start follow from seq 1
    const controller = new AbortController()
    const followPromise = fetchSocket('/v1/events?follow=true&fromSeq=1', {
      signal: controller.signal,
    })
    const followCapture = collectFollowStream(followPromise)

    // Add more events during follow
    for (let i = 0; i < 3; i++) {
      await postJson('/v1/sessions/resolve', {
        sessionRef: `project:mono-extra-${i}/lane:default`,
      })
    }

    await new Promise((r) => setTimeout(r, 200))
    controller.abort()
    const followText = await followCapture

    const followEvents = followText.trim().length > 0 ? parseNdjson(followText) : []

    if (followEvents.length > 1) {
      // Verify monotonic ordering
      for (let i = 1; i < followEvents.length; i++) {
        const prevSeq = Number(followEvents[i - 1].seq)
        const currSeq = Number(followEvents[i].seq)
        expect(currSeq).toBeGreaterThan(prevSeq) // Must be strictly increasing
      }

      // Verify no duplicates
      const seqs = followEvents.map((e) => Number(e.seq))
      const uniqueSeqs = new Set(seqs)
      expect(uniqueSeqs.size).toBe(seqs.length) // No duplicate seqs
    }
  })
})
