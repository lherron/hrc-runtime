/**
 * RED tests (T-01809 / T-01801 Phase 0) — tighten the direct-tmux degraded
 * fallback so a `sendKeys` paste STOPS being treated as semantic completion.
 *
 * Governing task: T-01809 (parent T-01801, refinement C-03099). The interactive
 * broker dispatch path falls back to `deliverReassociatedBrokerTmuxInput()` when
 * the in-memory broker controller no longer has the runtime active (e.g. after
 * an hrc-server restart) but the leased TUI pane is still alive. At HEAD that
 * fallback FAKES completion: it emits `turn.completed`, marks the run
 * `status:'completed'`, clears `runtime.activeRunId`, and flips the runtime back
 * to a healthy `ready`. None of that is real — only a literal paste reached the
 * TUI; no broker/hook/terminal event ever confirmed the turn.
 *
 * These tests pin the Phase-0 contract and are EXPECTED TO FAIL at HEAD. They go
 * green once the degraded path:
 *   #1  does NOT emit `turn.completed` and does NOT mark the run completed;
 *   #2  leaves the runtime non-`ready` with `activeRunId` STILL set (no real
 *       terminal event arrived, so the system must not accept more work as if
 *       the turn finished);
 *   #3  emits an explicit `turn.degraded_input_delivered` diagnostic instead of
 *       overclaiming with an existing turn name;
 *   #4  persists `control.mode='direct-tmux-degraded'` + `brokerAttached=false`
 *       into the runtime's `runtime_state_json`;
 *   #5  (minimal surfacing) exposes that degraded state via the runtime inspect
 *       path so operators don't see a permanently-`started` run with no reason.
 *
 * This exercises the REAL function over a REAL tmux pane (kept "live" by a
 * non-shell foreground process so liveness passes) and a real HRC SQLite db.
 * It launches/execs no harness; the only external dependency is the tmux binary,
 * matching the other broker-tmux lease tests in this suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLifecycleEvent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { deliverReassociatedBrokerTmuxInput } from '../broker-interactive-handlers'
import { createTmuxManager } from '../tmux'

const PROMPT = 'follow-up question after hrc restart'

type Fixture = {
  db: HrcDatabase
  dir: string
  leaseSocket: string
  sessionName: string
  cleanup: () => Promise<void>
}

let fixture: Fixture

beforeEach(async () => {
  fixture = await makeFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

/**
 * Create a REAL tmux session whose pane runs a non-shell foreground process
 * (`sleep`) so `inspectPaneLiveness` reports `alive:true` — without that the
 * fallback short-circuits before delivery and the contract is never exercised.
 */
async function createLiveSession(socketPath: string, sessionName: string): Promise<void> {
  const { exited } = Bun.spawn(
    [
      'tmux',
      '-S',
      socketPath,
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-n',
      'main',
      'sleep 600',
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  )
  expect(await exited).toBe(0)
}

async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-degraded-tmux-fallback-'))
  const leaseSocket = join(dir, 'lease.sock')
  const sessionName = 'hrc-claude-code-tmux-runtime_degraded'

  await createLiveSession(leaseSocket, sessionName)
  const db = openHrcDatabase(join(dir, 'state.sqlite'))

  return {
    db,
    dir,
    leaseSocket,
    sessionName,
    cleanup: async () => {
      db.close()
      try {
        const { exited } = Bun.spawn(['tmux', '-S', leaseSocket, 'kill-server'], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        await exited
      } catch {
        // fine when the server is already gone
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
}

type Seeded = {
  session: HrcSessionRecord
  runtime: HrcRuntimeSnapshot
  runId: string
  events: HrcLifecycleEvent[]
  fakeThis: { db: HrcDatabase; notifyEvent: (event: HrcLifecycleEvent) => void }
}

/**
 * Seed an interactive broker-tmux runtime that is mid-turn (busy, activeRunId
 * set) and whose persisted lease matches the live pane, then build a minimal
 * `this` carrying only what the handler reads (`db` + `notifyEvent`).
 */
async function seed(): Promise<Seeded> {
  const now = new Date().toISOString()
  const hostSessionId = 'hsid_degraded'
  const scopeRef = 'agent:smokey:project:hrc-runtime:task:T-01809'
  const runtimeId = 'runtime_degraded'
  const invocationId = 'inv_degraded'
  const runId = 'run_degraded'

  fixture.db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })

  const lease = createTmuxManager({ socketPath: fixture.leaseSocket })
  const pane = await lease.inspectSession(fixture.sessionName)
  if (!pane) throw new Error('failed to allocate live leased tmux pane fixture')

  fixture.db.runtimes.insert({
    runtimeId,
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'busy',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeRunId: runId,
    activeInvocationId: invocationId,
    tmuxJson: {
      socketPath: fixture.leaseSocket,
      sessionName: fixture.sessionName,
      windowName: 'main',
      sessionId: pane.sessionId,
      windowId: pane.windowId,
      paneId: pane.paneId,
      brokerDriver: 'claude-code-tmux',
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })

  // The dispatch caller inserts the run before falling back; mirror that so the
  // handler's run updates land on a real row.
  fixture.db.runs.insert({
    runId,
    hostSessionId,
    runtimeId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
    invocationId,
  })

  const runtime = fixture.db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) throw new Error('failed to read back seeded runtime')
  const session = fixture.db.sessions.getByHostSessionId(hostSessionId)
  if (!session) throw new Error('failed to read back seeded session')

  const events: HrcLifecycleEvent[] = []
  const fakeThis = {
    db: fixture.db,
    notifyEvent: (event: HrcLifecycleEvent) => {
      events.push(event)
    },
  }

  return { session, runtime, runId, events, fakeThis }
}

function emittedKinds(events: HrcLifecycleEvent[]): string[] {
  return events.map((event) => event.eventKind)
}

describe('RED: direct-tmux degraded fallback stops faking completion (T-01809)', () => {
  it('#1 does NOT emit turn.completed and does NOT mark the run completed', async () => {
    const { session, runtime, runId, events, fakeThis } = await seed()

    const delivered = await deliverReassociatedBrokerTmuxInput.call(
      fakeThis,
      session,
      runtime,
      PROMPT,
      runId
    )
    expect(delivered).toBe(true)

    // A literal paste is NOT semantic completion: no fake turn.completed event.
    expect(emittedKinds(events)).not.toContain('turn.completed')

    // ...and the run row must NOT be marked completed.
    const run = fixture.db.runs.getByRunId(runId)
    expect(run?.status).not.toBe('completed')
  })

  it('#2 leaves runtime non-ready with activeRunId still set (no real terminal event)', async () => {
    const { session, runtime, runId, fakeThis } = await seed()

    await deliverReassociatedBrokerTmuxInput.call(fakeThis, session, runtime, PROMPT, runId)

    const after = fixture.db.runtimes.getByRuntimeId(runtime.runtimeId)
    // The runtime must not be flipped back to a healthy 'ready': no broker/hook
    // event confirmed the turn finished, so accepting more work would be unsafe.
    expect(after?.status).not.toBe('ready')
    // activeRunId must NOT be cleared while the turn's true outcome is unknown.
    expect(after?.activeRunId).toBe(runId)
  })

  it('#3 emits an explicit turn.degraded_input_delivered diagnostic', async () => {
    const { session, runtime, runId, events, fakeThis } = await seed()

    await deliverReassociatedBrokerTmuxInput.call(fakeThis, session, runtime, PROMPT, runId)

    expect(emittedKinds(events)).toContain('turn.degraded_input_delivered')
  })

  it('#4 persists control.mode=direct-tmux-degraded + brokerAttached=false into runtime_state_json', async () => {
    const { session, runtime, runId, fakeThis } = await seed()

    await deliverReassociatedBrokerTmuxInput.call(fakeThis, session, runtime, PROMPT, runId)

    const after = fixture.db.runtimes.getByRuntimeId(runtime.runtimeId)
    const control = (after?.runtimeStateJson?.['control'] ?? undefined) as
      | { mode?: unknown; brokerAttached?: unknown }
      | undefined
    expect(control?.mode).toBe('direct-tmux-degraded')
    expect(control?.brokerAttached).toBe(false)
  })
})
