/**
 * T-07594 §5.1–5.2 — `publishPresentation` writes the DURABLE half of a
 * presentation decision and publishes the invocation-local half.
 *
 * The two halves are the whole point of the rev-3 spec, so they are asserted
 * separately here:
 *
 *  - `operatorAttachPending` is invocation-local. It rides on the event and is
 *    NEVER persisted — asserted against the raw sqlite column, not just the
 *    mapped snapshot, because a mapper could hide a stray key.
 *  - `viewerRequested` is the cumulative consequence and is MONOTONE within a
 *    generation: false → true on the first non-suppressed invocation, and a
 *    LATER suppressed invocation must not clear it. That is what makes an
 *    `hrc run` runtime later reused by a detached `hrc start` gain a pane, and
 *    what lets a reconcile reproduce the event path's cumulative outcome.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HrcEventEnvelope, HrcLifecycleEvent, HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { publishPresentation } from '../presentation-publish'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

const HOST_SESSION_ID = 'hsid-07594'
const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-07594'
const LANE_REF = 'default'
const RUNTIME_ID = 'rt-07594'
const TMUX_SOCKET = '/tmp/hrc-t07594/btmux/rt-07594.sock'
const SESSION_NAME = 'hrc-t07594'
const PAST = '2026-08-01T00:00:00.000Z'

const BROKER_WINDOW = { sessionId: '$1', windowId: '@1', paneId: '%1' }
const TUI_WINDOW = { sessionId: '$1', windowId: '@2', paneId: '%2' }

type SpawnCall = { runtimeId: string; options: { operatorAttachPending?: boolean | undefined } }

type Fixture = {
  db: ReturnType<typeof openHrcDatabase>
  dir: string
  notified: Array<HrcEventEnvelope | HrcLifecycleEvent>
  spawns: SpawnCall[]
  server: HrcServerInstanceForHandlers
  cleanup: () => Promise<void>
}

let fixture: Fixture

function brokerRuntimeState(presentationKind: 'tmux-tui' | 'none'): Record<string, unknown> {
  return {
    schemaVersion: 'runtime-state/v1',
    kind: 'harness-broker',
    runtimeId: RUNTIME_ID,
    broker: {
      protocolVersion: 'harness-broker/0.2',
      ownerServerInstanceId: 'hrc-server-test-07594',
      endpoint: {
        kind: 'unix-jsonrpc-ndjson',
        socketPath: '/tmp/hrc-t07594/bipc/b.sock',
        attachTokenRef: { kind: 'file', path: '/tmp/hrc-t07594/bipc/attach.token', redacted: true },
      },
      substrate: {
        kind: 'leased-tmux',
        tmuxSocketPath: TMUX_SOCKET,
        sessionName: SESSION_NAME,
        brokerWindow: BROKER_WINDOW,
        generation: 1,
        eventLedgerPath: '/tmp/hrc-t07594/bipc/events.ndjson',
      },
      presentation:
        presentationKind === 'tmux-tui'
          ? {
              kind: 'tmux-tui',
              tuiWindow: TUI_WINDOW,
              operatorAttachTarget: true,
              attachCommand: `tmux -S ${TMUX_SOCKET} attach -t ${SESSION_NAME}:tui`,
            }
          : { kind: 'none' },
    },
    control: { mode: 'broker-ipc', brokerAttached: false },
  }
}

function seedRuntime(presentationKind: 'tmux-tui' | 'none'): HrcRuntimeSnapshot {
  return fixture.db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    tmuxJson: {
      socketPath: TMUX_SOCKET,
      sessionName: SESSION_NAME,
      sessionId: TUI_WINDOW.sessionId,
      windowId: TUI_WINDOW.windowId,
      paneId: TUI_WINDOW.paneId,
      windowName: 'tui',
    },
    runtimeStateJson: brokerRuntimeState(presentationKind),
    createdAt: PAST,
    updatedAt: PAST,
  })
}

function seedSession(viewerWindow?: string): void {
  fixture.db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    status: 'active',
    createdAt: PAST,
    updatedAt: PAST,
    ancestorScopeRefs: [],
    ...(viewerWindow === undefined
      ? {}
      : {
          lastAppliedIntentJson: {
            harness: { id: 'claude-code', provider: 'anthropic' },
            presentation: { viewerWindow },
          } as never,
        }),
  })
}

/** Raw column read — proves nothing invocation-local reached the row. */
function rawPresentationJson(): string | null {
  return (
    fixture.db.sqlite
      .query<{ presentation_json: string | null }, [string]>(
        'SELECT presentation_json FROM runtimes WHERE runtime_id = ?'
      )
      .get(RUNTIME_ID)?.presentation_json ?? null
  )
}

/** Durable ledger count — the notify seam is a projection, the ledger is the fact. */
function ledgerCount(eventKind: string): number {
  return (
    fixture.db.sqlite
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM hrc_events WHERE event_kind = ?'
      )
      .get(eventKind)?.count ?? 0
  )
}

function presentationEvents(): Array<Record<string, unknown>> {
  return fixture.notified
    .filter((event) => 'eventKind' in event && event.eventKind === 'runtime.presentation')
    .map((event) => (event as HrcEventEnvelope).payload as Record<string, unknown>)
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-t07594-publish-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  const notified: Array<HrcEventEnvelope | HrcLifecycleEvent> = []
  const spawns: SpawnCall[] = []
  const server = {
    db,
    notifyEvent: (event: HrcEventEnvelope | HrcLifecycleEvent) => {
      notified.push(event)
    },
    // The in-daemon viewer spawn is the ONE seam stubbed here: it shells to
    // ghostmux. Everything publishPresentation persists and appends is real.
    spawnBrokerHeadlessViewer: async (
      runtime: HrcRuntimeSnapshot,
      options: { operatorAttachPending?: boolean | undefined } = {}
    ) => {
      spawns.push({ runtimeId: runtime.runtimeId, options })
    },
  } as unknown as HrcServerInstanceForHandlers

  fixture = {
    db,
    dir,
    notified,
    spawns,
    server,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('publishPresentation — persisted record (§5.1)', () => {
  it('a non-suppressed invocation records attachable + requested and the window key', async () => {
    seedSession('headless-sessions')
    const runtime = seedRuntime('tmux-tui')

    await publishPresentation.call(fixture.server, runtime, { operatorAttachPending: false })

    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.presentation).toEqual({
      operatorAttachable: true,
      viewerRequested: true,
      viewerWindow: 'headless-sessions',
    })
  })

  it('never persists operatorAttachPending, in any column shape', async () => {
    seedSession()
    const runtime = seedRuntime('tmux-tui')

    await publishPresentation.call(fixture.server, runtime, { operatorAttachPending: true })

    expect(rawPresentationJson()).not.toContain('operatorAttachPending')
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.presentation).toEqual({
      operatorAttachable: true,
      viewerRequested: false,
    })
  })

  it('viewerRequested is monotone: a later suppressed invocation cannot clear it', async () => {
    seedSession()
    const runtime = seedRuntime('tmux-tui')

    await publishPresentation.call(fixture.server, runtime, { operatorAttachPending: true })
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.presentation?.viewerRequested).toBe(
      false
    )

    // Detached reuse of an `hrc run` runtime: the pane appears from here on.
    await publishPresentation.call(fixture.server, runtime, { operatorAttachPending: false })
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.presentation?.viewerRequested).toBe(true)

    await publishPresentation.call(fixture.server, runtime, { operatorAttachPending: true })
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.presentation?.viewerRequested).toBe(true)
  })

  it('records operatorAttachable=false for a presentation-less runtime', async () => {
    seedSession()
    const runtime = seedRuntime('none')

    await publishPresentation.call(fixture.server, runtime, {})

    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.presentation).toEqual({
      operatorAttachable: false,
      viewerRequested: true,
    })
  })

  it('folds onto the PERSISTED record, not the caller-held snapshot', async () => {
    seedSession()
    const stale = seedRuntime('tmux-tui')

    await publishPresentation.call(fixture.server, stale, { operatorAttachPending: false })
    // `stale` still carries presentation: undefined; a fold over it would reset.
    expect(stale.presentation).toBeUndefined()

    await publishPresentation.call(fixture.server, stale, { operatorAttachPending: true })
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.presentation?.viewerRequested).toBe(true)
  })
})

describe('publishPresentation — runtime.presentation event (§5.2)', () => {
  it('carries the invocation predicate, the record, and tmux coordinates', async () => {
    seedSession('headless-sessions')
    const runtime = seedRuntime('tmux-tui')
    fixture.db.sessionTitles.upsert({
      hostSessionId: HOST_SESSION_ID,
      title: 'viewer sidecar',
      source: 'manual',
      createdAt: PAST,
      updatedAt: PAST,
    })

    await publishPresentation.call(fixture.server, runtime, { operatorAttachPending: false })

    expect(presentationEvents()).toEqual([
      {
        invocation: { operatorAttachPending: false },
        presentation: {
          operatorAttachable: true,
          viewerRequested: true,
          viewerWindow: 'headless-sessions',
        },
        tmux: { socketPath: TMUX_SOCKET, attachTarget: `${SESSION_NAME}:tui` },
        title: 'viewer sidecar',
      },
    ])
  })

  it('omits tmux when the runtime is not operator-attachable', async () => {
    seedSession()
    const runtime = seedRuntime('none')

    await publishPresentation.call(fixture.server, runtime, { operatorAttachPending: false })

    const [payload] = presentationEvents()
    expect(payload).toBeDefined()
    expect('tmux' in (payload as object)).toBe(false)
  })

  it('is appended on EVERY invocation, including a reuse that changes nothing', async () => {
    seedSession()
    const runtime = seedRuntime('tmux-tui')

    await publishPresentation.call(fixture.server, runtime, { operatorAttachPending: true })
    await publishPresentation.call(fixture.server, runtime, { operatorAttachPending: false })
    await publishPresentation.call(fixture.server, runtime, { operatorAttachPending: false })

    expect(presentationEvents().map((payload) => payload['invocation'])).toEqual([
      { operatorAttachPending: true },
      { operatorAttachPending: false },
      { operatorAttachPending: false },
    ])
    expect(ledgerCount('runtime.presentation')).toBe(3)
  })
})

describe('publishPresentation — behavior is unchanged until Phase 4', () => {
  it('still invokes the in-daemon viewer spawn with the same options', async () => {
    seedSession()
    const runtime = seedRuntime('tmux-tui')

    await publishPresentation.call(fixture.server, runtime, { operatorAttachPending: true })
    await publishPresentation.call(fixture.server, runtime, {})

    expect(fixture.spawns).toEqual([
      { runtimeId: RUNTIME_ID, options: { operatorAttachPending: true } },
      { runtimeId: RUNTIME_ID, options: {} },
    ])
  })

  it('a new generation starts with no record — monotone is per generation', async () => {
    seedSession()
    const first = seedRuntime('tmux-tui')
    await publishPresentation.call(fixture.server, first, { operatorAttachPending: false })

    fixture.db.sessions.insert({
      hostSessionId: 'hsid-07594-gen2',
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: 2,
      status: 'active',
      createdAt: PAST,
      updatedAt: PAST,
      ancestorScopeRefs: [],
    })
    const second = fixture.db.runtimes.insert({
      ...first,
      runtimeId: 'rt-07594-gen2',
      hostSessionId: 'hsid-07594-gen2',
      generation: 2,
      presentation: undefined,
    })

    await publishPresentation.call(fixture.server, second, { operatorAttachPending: true })

    expect(fixture.db.runtimes.getByRuntimeId('rt-07594-gen2')?.presentation?.viewerRequested).toBe(
      false
    )
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.presentation?.viewerRequested).toBe(true)
  })
})
