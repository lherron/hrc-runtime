import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcHttpError, HrcLifecycleEvent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { TmuxManager } from '../tmux'
import { createHrcTestFixture, setTmuxPanePrompt } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

const CONTROLLED_TMUX_PROMPT = 'hrc-test> '
const LONG_AMBIENT_TMUX_PROMPT = `${'ambient-prompt-'.repeat(5)}> `

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-runtime-actions-headless-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

type SeedRuntimeOptions = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  transport: 'headless' | 'sdk'
  status?: string | undefined
  activeRunId?: string | undefined
}

async function setupTmuxRuntime(
  label: string,
  runtimeId: string,
  options: { status?: string; initialPrompt?: string } = {}
) {
  const tmux = new TmuxManager(fixture.tmuxSocketPath)
  await tmux.initialize()
  const { hostSessionId } = await fixture.resolveSession(label)
  const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')

  if (options.initialPrompt) {
    await setTmuxPanePrompt(tmux, pane.paneId, options.initialPrompt, 'HRC_INITIAL_PROMPT_READY')
  }
  await setTmuxPanePrompt(tmux, pane.paneId, CONTROLLED_TMUX_PROMPT, 'HRC_TEST_PROMPT_READY')

  fixture.seedTmuxRuntime(hostSessionId, label, runtimeId, { status: options.status ?? 'ready' })
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.runtimes.update(runtimeId, {
      tmuxJson: pane,
      updatedAt: fixture.now(),
    })
  } finally {
    db.close()
  }

  return { tmux, hostSessionId, pane }
}

async function setupHeadlessBrokerPresentationRuntime(
  runtimeId: string,
  presentation: 'tmux-tui' | 'observer' = 'tmux-tui',
  stateShape: 'flat' | 'normalized' = 'flat'
) {
  const tmux = new TmuxManager(fixture.tmuxSocketPath)
  await tmux.initialize()
  const sessionName = `capture-broker-${runtimeId}`
  await tmux.createLeaseSession(sessionName)
  const brokerPane = await tmux.createOrInspectWindow({
    sessionName,
    windowName: 'broker',
  })
  const presentationWindowName = presentation === 'tmux-tui' ? 'tui' : 'observer'
  const presentationPane = await tmux.createOrInspectWindow({
    sessionName,
    windowName: presentationWindowName,
  })

  await setTmuxPanePrompt(tmux, brokerPane.paneId, CONTROLLED_TMUX_PROMPT, 'BROKER_PANE_READY')
  await setTmuxPanePrompt(
    tmux,
    presentationPane.paneId,
    CONTROLLED_TMUX_PROMPT,
    'PRESENTATION_PANE_READY'
  )
  await tmux.sendLiteral(brokerPane.paneId, 'BROKER_WINDOW_MUST_NOT_BE_CAPTURED')
  await tmux.sendLiteral(presentationPane.paneId, 'PRESENTATION_WINDOW_CAPTURED')

  const hostSessionId = `hsid-${runtimeId}`
  seedHeadlessRuntime({
    runtimeId,
    hostSessionId,
    scopeRef: runtimeId,
    transport: 'headless',
  })

  const db = openHrcDatabase(fixture.dbPath)
  try {
    const brokerWindow = {
      socketPath: fixture.tmuxSocketPath,
      sessionName,
      windowName: 'broker',
      sessionId: brokerPane.sessionId,
      windowId: brokerPane.windowId,
      paneId: brokerPane.paneId,
    }
    const presentationWindow = {
      socketPath: fixture.tmuxSocketPath,
      sessionName,
      windowName: presentationWindowName,
      sessionId: presentationPane.sessionId,
      windowId: presentationPane.windowId,
      paneId: presentationPane.paneId,
    }
    db.runtimes.update(runtimeId, {
      controllerKind: 'harness-broker',
      runtimeStateJson: {
        broker:
          stateShape === 'flat'
            ? {
                protocolVersion: 'harness-broker/0.2',
                endpoint: {
                  kind: 'unix-jsonrpc-ndjson',
                  socketPath: `${fixture.runtimeRoot}/broker.sock`,
                  attachTokenRef: { kind: 'file', path: `${fixture.runtimeRoot}/broker.token` },
                },
                generation: 1,
                brokerWindow,
                ...(presentation === 'tmux-tui'
                  ? { tuiWindow: presentationWindow }
                  : { observerWindow: presentationWindow }),
              }
            : {
                endpoint: {
                  kind: 'unix-jsonrpc-ndjson',
                  socketPath: `${fixture.runtimeRoot}/broker.sock`,
                  attachTokenRef: { kind: 'file', path: `${fixture.runtimeRoot}/broker.token` },
                  protocolVersion: 'harness-broker/0.2',
                },
                substrate: {
                  kind: 'leased-tmux',
                  tmuxSocketPath: fixture.tmuxSocketPath,
                  sessionName,
                  brokerWindow: {
                    sessionId: brokerPane.sessionId,
                    windowId: brokerPane.windowId,
                    paneId: brokerPane.paneId,
                  },
                  generation: 1,
                  eventLedgerPath: `${fixture.runtimeRoot}/broker.ndjson`,
                },
                presentation:
                  presentation === 'tmux-tui'
                    ? {
                        kind: 'tmux-tui',
                        tuiWindow: {
                          sessionId: presentationPane.sessionId,
                          windowId: presentationPane.windowId,
                          paneId: presentationPane.paneId,
                        },
                        operatorAttachTarget: true,
                      }
                    : {
                        kind: 'observer',
                        observerWindow: {
                          sessionId: presentationPane.sessionId,
                          windowId: presentationPane.windowId,
                          paneId: presentationPane.paneId,
                        },
                        operatorAttachTarget: true,
                      },
              },
      },
      updatedAt: fixture.now(),
    })
  } finally {
    db.close()
  }

  return { brokerPane, presentationPane }
}

function seedHeadlessRuntime(options: SeedRuntimeOptions): void {
  fixture.seedSession(options.hostSessionId, options.scopeRef)
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  const scopeRef = options.scopeRef.startsWith('agent:')
    ? options.scopeRef
    : `agent:${options.scopeRef}`

  try {
    db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId: options.hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: options.transport,
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: options.status ?? (options.activeRunId ? 'busy' : 'ready'),
      supportsInflightInput: false,
      adopted: false,
      ...(options.activeRunId ? { activeRunId: options.activeRunId } : {}),
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })

    if (options.activeRunId) {
      db.runs.insert({
        runId: options.activeRunId,
        hostSessionId: options.hostSessionId,
        runtimeId: options.runtimeId,
        scopeRef,
        laneRef: 'default',
        generation: 1,
        transport: options.transport,
        status: 'running',
        acceptedAt: now,
        startedAt: now,
        updatedAt: now,
      })
    }
  } finally {
    db.close()
  }
}

function listInterruptedEvents(runtimeId: string): HrcLifecycleEvent[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents
      .listFromHrcSeq(1)
      .filter((event) => event.eventKind === 'runtime.interrupted' && event.runtimeId === runtimeId)
  } finally {
    db.close()
  }
}

async function interrupt(runtimeId: string): Promise<Response> {
  return await fixture.postJson('/v1/interrupt', { runtimeId })
}

async function capture(runtimeId: string): Promise<Response> {
  return await fixture.fetchSocket(`/v1/capture?runtimeId=${encodeURIComponent(runtimeId)}`)
}

async function adopt(runtimeId: string): Promise<Response> {
  return await fixture.postJson('/v1/runtimes/adopt', { runtimeId })
}

describe('runtime interrupt transport branching', () => {
  it('keeps the tmux interrupt path working', async () => {
    await setupTmuxRuntime('interrupt-tmux', 'rt-interrupt-tmux')

    const res = await interrupt('rt-interrupt-tmux')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      runtimeId: 'rt-interrupt-tmux',
    })

    const events = listInterruptedEvents('rt-interrupt-tmux')
    expect(events).toHaveLength(1)
    expect(events[0]?.transport).toBe('tmux')
    expect(events[0]?.payload).toMatchObject({ transport: 'tmux' })
  })

  it('cancels an active headless run and clears active_run_id', async () => {
    seedHeadlessRuntime({
      runtimeId: 'rt-interrupt-headless-active',
      hostSessionId: 'hsid-interrupt-headless-active',
      scopeRef: 'interrupt-headless-active',
      transport: 'headless',
      activeRunId: 'run-interrupt-headless-active',
    })

    const res = await interrupt('rt-interrupt-headless-active')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      hostSessionId: 'hsid-interrupt-headless-active',
      runtimeId: 'rt-interrupt-headless-active',
    })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runs.getByRunId('run-interrupt-headless-active')?.status).toBe('cancelled')
      expect(
        db.runtimes.getByRuntimeId('rt-interrupt-headless-active')?.activeRunId
      ).toBeUndefined()
    } finally {
      db.close()
    }

    const events = listInterruptedEvents('rt-interrupt-headless-active')
    expect(events).toHaveLength(1)
    expect(events[0]?.transport).toBe('headless')
    expect(events[0]?.payload).toMatchObject({
      transport: 'headless',
      runId: 'run-interrupt-headless-active',
    })
  })

  it('no-ops headless interrupt without an active run', async () => {
    seedHeadlessRuntime({
      runtimeId: 'rt-interrupt-headless-ready',
      hostSessionId: 'hsid-interrupt-headless-ready',
      scopeRef: 'interrupt-headless-ready',
      transport: 'headless',
    })

    const res = await interrupt('rt-interrupt-headless-ready')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      runtimeId: 'rt-interrupt-headless-ready',
      warning: 'no active run to interrupt',
    })
    expect(listInterruptedEvents('rt-interrupt-headless-ready')).toHaveLength(0)
  })
})

describe('runtime capture transport branching', () => {
  it('keeps the tmux capture path working', async () => {
    expect(LONG_AMBIENT_TMUX_PROMPT.length).toBeGreaterThan(60)
    const { tmux, pane } = await setupTmuxRuntime('capture-tmux', 'rt-capture-tmux', {
      initialPrompt: LONG_AMBIENT_TMUX_PROMPT,
    })
    await tmux.sendLiteral(pane.paneId, 'CAPTURE_TMUX_MARKER')

    let body: { text?: string } = {}
    for (let attempt = 0; attempt < 20; attempt++) {
      const res = await capture('rt-capture-tmux')
      expect(res.status).toBe(200)
      body = (await res.json()) as { text?: string }
      if (body.text?.includes('CAPTURE_TMUX_MARKER')) break
      await Bun.sleep(50)
    }

    expect(body).toMatchObject({
      text: expect.stringContaining('CAPTURE_TMUX_MARKER'),
    })
  })

  it('refuses headless capture with event-stream guidance', async () => {
    seedHeadlessRuntime({
      runtimeId: 'rt-capture-headless',
      hostSessionId: 'hsid-capture-headless',
      scopeRef: 'capture-headless',
      transport: 'headless',
    })

    const res = await capture('rt-capture-headless')
    expect(res.status).toBe(400)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.message).toContain('use the runtime event stream')
    expect(body.error.detail).toMatchObject({
      runtimeId: 'rt-capture-headless',
      transport: 'headless',
    })
  })

  it('refuses a durable broker whose configured presentation is none', async () => {
    seedHeadlessRuntime({
      runtimeId: 'rt-capture-broker-none',
      hostSessionId: 'hsid-capture-broker-none',
      scopeRef: 'capture-broker-none',
      transport: 'headless',
    })
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.update('rt-capture-broker-none', {
        controllerKind: 'harness-broker',
        runtimeStateJson: {
          broker: {
            endpoint: {
              kind: 'unix-jsonrpc-ndjson',
              socketPath: `${fixture.runtimeRoot}/broker.sock`,
              attachTokenRef: { kind: 'file', path: `${fixture.runtimeRoot}/broker.token` },
              protocolVersion: 'harness-broker/0.2',
            },
            substrate: {
              kind: 'leased-tmux',
              tmuxSocketPath: fixture.tmuxSocketPath,
              sessionName: 'capture-broker-none',
              brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
              generation: 1,
              eventLedgerPath: `${fixture.runtimeRoot}/broker.ndjson`,
            },
            presentation: { kind: 'none' },
          },
        },
        updatedAt: fixture.now(),
      })
    } finally {
      db.close()
    }

    const res = await capture('rt-capture-broker-none')

    expect(res.status).toBe(400)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.message).toContain('use the runtime event stream')
  })

  it('captures only the durable TUI presentation pane for a headless broker runtime', async () => {
    await setupHeadlessBrokerPresentationRuntime('rt-capture-broker-tui')

    const res = await capture('rt-capture-broker-tui')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { text: string }
    expect(body.text).toContain('PRESENTATION_WINDOW_CAPTURED')
    expect(body.text).not.toContain('BROKER_WINDOW_MUST_NOT_BE_CAPTURED')
  })

  it('captures only the durable observer presentation pane for a headless broker runtime', async () => {
    await setupHeadlessBrokerPresentationRuntime(
      'rt-capture-broker-observer',
      'observer',
      'normalized'
    )

    const res = await capture('rt-capture-broker-observer')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { text: string }
    expect(body.text).toContain('PRESENTATION_WINDOW_CAPTURED')
    expect(body.text).not.toContain('BROKER_WINDOW_MUST_NOT_BE_CAPTURED')
  })

  it('fails closed when the persisted presentation pane identity no longer matches tmux', async () => {
    await setupHeadlessBrokerPresentationRuntime('rt-capture-broker-stale')
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const runtime = db.runtimes.getByRuntimeId('rt-capture-broker-stale')!
      const state = runtime.runtimeStateJson as Record<string, unknown>
      const broker = state['broker'] as Record<string, unknown>
      const tuiWindow = broker['tuiWindow'] as Record<string, unknown>
      db.runtimes.update('rt-capture-broker-stale', {
        runtimeStateJson: {
          ...state,
          broker: {
            ...broker,
            tuiWindow: { ...tuiWindow, paneId: '%stale-presentation-pane' },
          },
        },
        updatedAt: fixture.now(),
      })
    } finally {
      db.close()
    }

    const res = await capture('rt-capture-broker-stale')

    expect(res.status).toBe(503)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.message).toContain('presentation pane is unavailable or changed')
  })
})

describe('runtime adopt transport branching', () => {
  it('keeps the tmux adopt path working', async () => {
    fixture.seedSession('hsid-adopt-tmux', 'adopt-tmux')
    fixture.seedTmuxRuntime('hsid-adopt-tmux', 'adopt-tmux', 'rt-adopt-tmux', { status: 'dead' })

    const res = await adopt('rt-adopt-tmux')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      runtimeId: 'rt-adopt-tmux',
      status: 'adopted',
      adopted: true,
    })
  })

  it('refuses headless adopt', async () => {
    seedHeadlessRuntime({
      runtimeId: 'rt-adopt-headless',
      hostSessionId: 'hsid-adopt-headless',
      scopeRef: 'adopt-headless',
      transport: 'headless',
      status: 'dead',
    })

    const res = await adopt('rt-adopt-headless')
    expect(res.status).toBe(400)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.message).toBe(
      'cannot adopt a non-tmux runtime: no attachable pane/process exists'
    )
    expect(body.error.detail).toMatchObject({
      runtimeId: 'rt-adopt-headless',
      transport: 'headless',
    })
  })

  it('refuses sdk adopt', async () => {
    seedHeadlessRuntime({
      runtimeId: 'rt-adopt-sdk',
      hostSessionId: 'hsid-adopt-sdk',
      scopeRef: 'adopt-sdk',
      transport: 'sdk',
      status: 'dead',
    })

    const res = await adopt('rt-adopt-sdk')
    expect(res.status).toBe(400)
    const body = (await res.json()) as HrcHttpError
    expect(body.error.message).toBe(
      'cannot adopt a non-tmux runtime: no attachable pane/process exists'
    )
    expect(body.error.detail).toMatchObject({
      runtimeId: 'rt-adopt-sdk',
      transport: 'sdk',
    })
  })
})
