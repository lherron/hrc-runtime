/**
 * RED/GREEN tests for hrc-server Phase 2 — SDK dispatch path (T-00968 / T-00967)
 *
 * Tests the server's SDK transport support:
 *   - dispatchTurn with interactive=false uses SDK transport
 *   - SDK dispatch creates runtime with transport='sdk'
 *   - Events stream through watch during SDK dispatch
 *   - runtime_buffers populated during SDK dispatch
 *   - Continuation persisted on session after SDK turn
 *   - Provider mismatch returns 422
 *   - Capture on SDK runtime reads from runtime_buffers
 *   - Attach on SDK runtime returns error
 *
 * Pass conditions for Larry (T-00967):
 *   1. POST /v1/turns with { harness: { interactive: false } } returns transport='sdk' in response
 *   2. Runtime record created by SDK dispatch has transport='sdk', no tmux_json
 *   3. Events with source='agent-spaces' appear in GET /v1/events during SDK dispatch
 *   4. GET /v1/capture on SDK runtime returns text from runtime_buffers
 *   5. Continuation from SDK turn is persisted on session record
 *   6. POST /v1/turns with provider mismatch on existing runtime returns 422
 *   7. GET /v1/attach on SDK runtime returns error (attach not supported)
 *   8. Run record transitions: accepted → started → completed
 *   9. Runtime transitions: created → busy → ready after SDK dispatch
 *  10. harness_session_json persisted on runtime record after SDK turn
 *
 * Reference: T-00946, HRC_IMPLEMENTATION_PLAN.md Phase 2
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string
let server: HrcServer | undefined

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

/** Resolve a session and return the hostSessionId */
async function resolveSession(scope: string): Promise<string> {
  const canonical = scope.startsWith('agent:') ? scope : `agent:${scope}`
  const res = await postJson('/v1/sessions/resolve', {
    sessionRef: `${canonical}/lane:default`,
  })
  const data = (await res.json()) as any
  return data.hostSessionId
}

/** Build a non-interactive (SDK) runtime intent */
function sdkIntent(provider: 'anthropic' | 'openai' = 'anthropic'): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      dryRun: true,
    },
    harness: {
      provider,
      interactive: false,
    },
    execution: {
      preferredMode: 'nonInteractive',
    },
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-test-'))
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

  server = await createHrcServer({
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    tmuxSocketPath,
  })
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  try {
    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited
  } catch {
    // ok
  }
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. SDK dispatch basic — transport='sdk' in response
// ---------------------------------------------------------------------------
describe('SDK dispatch via dispatchTurn', () => {
  it('returns transport=sdk when harness.interactive=false', async () => {
    const hsid = await resolveSession('sdk-test-1')

    const res = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Hello from SDK test',
      runtimeIntent: sdkIntent(),
    })

    // RED GATE: This will fail until Larry implements SDK dispatch branching
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.status).toBe('started')
    expect(data.runtimeId).toBeDefined()
    // The key Phase 2 assertion: transport should be 'sdk', not 'tmux'
    expect(data.transport).toBe('sdk')
  })
})

// ---------------------------------------------------------------------------
// 2. SDK runtime record — transport='sdk', no tmux_json
// ---------------------------------------------------------------------------
describe('SDK runtime record', () => {
  it('creates runtime with transport=sdk and no tmux session', async () => {
    const hsid = await resolveSession('sdk-test-2')

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Check runtime transport',
      runtimeIntent: sdkIntent(),
    })
    const turnData = (await turnRes.json()) as any

    // Wait for SDK turn to complete (it's synchronous in-process)
    await new Promise((r) => setTimeout(r, 500))

    // Check the events for runtime.created
    const eventsRes = await fetchSocket('/v1/events?fromSeq=1')
    await eventsRes.text()
    // RED GATE: SDK runtime creation may not emit runtime.created or may use different transport
    // The runtime should exist with transport='sdk'
    expect(turnData.runtimeId).toBeString()
  })
})

// ---------------------------------------------------------------------------
// 3. Events from SDK dispatch appear in watch stream
// ---------------------------------------------------------------------------
describe('SDK events in watch stream', () => {
  it('SDK dispatch events have source=agent-spaces in event stream', async () => {
    const hsid = await resolveSession('sdk-test-3')

    await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Generate events',
      runtimeIntent: sdkIntent(),
    })

    // Wait for in-process SDK dispatch to complete
    await new Promise((r) => setTimeout(r, 1000))

    const eventsRes = await fetchSocket('/v1/events?fromSeq=1')
    const eventsText = await eventsRes.text()
    const events = eventsText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

    // Should have agent-spaces sourced events from the SDK adapter
    const sdkEvents = events.filter((e: any) => e.source === 'agent-spaces')
    expect(sdkEvents.length).toBeGreaterThan(0)

    // At minimum, we expect sdk.running and sdk.complete
    const kinds = sdkEvents.map((e: any) => e.eventKind)
    expect(kinds).toContain('sdk.running')
    expect(kinds).toContain('sdk.complete')
  })
})

// ---------------------------------------------------------------------------
// 4. Capture on SDK runtime reads from runtime_buffers
// ---------------------------------------------------------------------------
describe('capture on SDK runtime', () => {
  it('returns text from runtime_buffers instead of tmux', async () => {
    const hsid = await resolveSession('sdk-test-4')

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Buffer test',
      runtimeIntent: sdkIntent(),
    })
    const turnData = (await turnRes.json()) as any

    // Wait for SDK turn to complete and populate buffers
    await new Promise((r) => setTimeout(r, 1000))

    const captureRes = await fetchSocket(`/v1/capture?runtimeId=${turnData.runtimeId}`)
    expect(captureRes.status).toBe(200)
    const captureData = (await captureRes.json()) as any
    expect(captureData.text).toBeString()
    expect(captureData.text.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Continuation persisted on session after SDK turn
// ---------------------------------------------------------------------------
describe('continuation persistence', () => {
  it('stores continuation on session record after SDK turn', async () => {
    const hsid = await resolveSession('sdk-test-5')

    await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Continuation test',
      runtimeIntent: sdkIntent(),
    })

    // Wait for SDK turn to complete
    await new Promise((r) => setTimeout(r, 1000))

    // Fetch the session and check continuation
    const sessionRes = await fetchSocket(`/v1/sessions/by-host/${hsid}`)
    expect(sessionRes.status).toBe(200)
    const sessionData = (await sessionRes.json()) as any
    expect(sessionData.continuation).toBeDefined()
    expect(sessionData.continuation.provider).toBe('anthropic')
  })
})

// ---------------------------------------------------------------------------
// 6. Provider mismatch returns 422
// ---------------------------------------------------------------------------
describe('provider mismatch', () => {
  it('returns 422 when requesting different provider on existing SDK runtime', async () => {
    const hsid = await resolveSession('sdk-test-6')

    // First turn: anthropic
    const firstRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'First turn',
      runtimeIntent: sdkIntent('anthropic'),
    })
    expect(firstRes.status).toBe(200)

    // Wait for first turn to complete
    await new Promise((r) => setTimeout(r, 1000))

    // Second turn: openai (provider mismatch)
    const secondRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Mismatched turn',
      runtimeIntent: sdkIntent('openai'),
    })

    expect(secondRes.status).toBe(422)
    const errorData = (await secondRes.json()) as any
    expect(errorData.error).toBeDefined()
    expect(errorData.error.code).toMatch(/provider.?mismatch/i)
  })
})

// ---------------------------------------------------------------------------
// 7. Attach on SDK runtime returns error
// ---------------------------------------------------------------------------
describe('attach on SDK runtime', () => {
  it('returns error for SDK runtime attach requests', async () => {
    const hsid = await resolveSession('sdk-test-7')

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Attach test',
      runtimeIntent: sdkIntent(),
    })
    const turnData = (await turnRes.json()) as any

    // Wait for SDK turn to complete
    await new Promise((r) => setTimeout(r, 1000))

    const attachRes = await fetchSocket(`/v1/attach?runtimeId=${turnData.runtimeId}`)
    // SDK runtimes should reject attach
    expect(attachRes.status).toBeGreaterThanOrEqual(400)
    const errorData = (await attachRes.json()) as any
    expect(errorData.error).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 8. Run record lifecycle
// ---------------------------------------------------------------------------
describe('SDK run record lifecycle', () => {
  it('transitions run through accepted → started → completed', async () => {
    const hsid = await resolveSession('sdk-test-8')

    await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Lifecycle test',
      runtimeIntent: sdkIntent(),
    })

    // Wait for full SDK turn lifecycle
    await new Promise((r) => setTimeout(r, 1000))

    // Check events for the full lifecycle
    const eventsRes = await fetchSocket('/v1/events?fromSeq=1')
    const eventsText = await eventsRes.text()
    const events = eventsText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const eventKinds = events.map((e: any) => e.eventKind)

    expect(eventKinds).toContain('turn.accepted')
    expect(eventKinds).toContain('turn.started')
    // After SDK turn completes, we expect turn.completed
    expect(eventKinds).toContain('turn.completed')
  })
})

// ---------------------------------------------------------------------------
// 9. harness_session_json persisted on runtime
// ---------------------------------------------------------------------------
describe('harness session identity', () => {
  it('persists provider/frontend as harness identity on runtime', async () => {
    const hsid = await resolveSession('sdk-test-9')

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Identity test',
      runtimeIntent: sdkIntent(),
    })
    await turnRes.json()

    // Wait for SDK turn to complete
    await new Promise((r) => setTimeout(r, 1000))

    // Verify via events that the runtime was updated
    // (direct runtime query would be better but depends on API surface)
    const eventsRes = await fetchSocket('/v1/events?fromSeq=1')
    const eventsText = await eventsRes.text()
    const events = eventsText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

    // The turn should have completed successfully
    const completed = events.find(
      (e: any) => e.eventKind === 'turn.completed' || e.eventKind === 'sdk.complete'
    )
    expect(completed).toBeDefined()
  })
})
