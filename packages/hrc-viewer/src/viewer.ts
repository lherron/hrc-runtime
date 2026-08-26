import type { HrcClient, HrcEventTail } from 'hrc-sdk'

import {
  type GhostmuxStatusBarSpec,
  type HeadlessReapResult,
  type HeadlessViewerPane,
  type HeadlessViewerResult,
  defaultHeadlessPaneTitle,
  deriveHeadlessSessionIdentity,
} from './ghostmux.js'
import {
  HeadlessViewerStatusProjector,
  renderStatusBar,
  viewerStateForEventKind,
  viewerTerminalBg,
} from './headless-viewer-status.js'
import { defaultTaskSlugResolver } from './wrkq-task-label.js'

export type HrcViewerClient = Pick<
  HrcClient,
  | 'health'
  | 'tailEvents'
  | 'watchBoundedEvents'
  | 'listLatestEventBySession'
  | 'listPresentationRuntimes'
>

type LifecycleEvent = HrcEventTail['events'][number]
type PresentationRuntimeRow = Awaited<
  ReturnType<HrcViewerClient['listPresentationRuntimes']>
>['runtimes'][number]

export type ViewerGhostmux = {
  ensureHeadlessViewer(options: {
    scopeRef: string
    laneRef?: string | undefined
    runtimeId: string
    hostSessionId?: string | undefined
    generation?: number | undefined
    attachCommand: string
    title?: string | undefined
    statusBar?: GhostmuxStatusBarSpec | undefined
    terminalBg?: string | undefined
    windowKey?: string | undefined
  }): Promise<HeadlessViewerResult>
  findHeadlessViewerSurfaceByRuntimeId(runtimeId: string): Promise<string | null>
  listHeadlessViewerPanes(): Promise<HeadlessViewerPane[]>
  rebindHeadlessViewerPane(
    surfaceId: string,
    options: {
      scopeRef: string
      laneRef?: string | undefined
      runtimeId: string
      hostSessionId: string
      generation: number
      windowKey?: string | undefined
    }
  ): Promise<void>
  setHeadlessViewerTitle(surfaceId: string, title: string): Promise<void>
  setStatusBar(surfaceId: string, spec: GhostmuxStatusBarSpec): Promise<void>
  reapHeadlessAgentPane(surfaceId: string, runtimeId: string): Promise<HeadlessReapResult>
}

export type ViewerLog = (
  level: 'INFO' | 'WARN',
  event: string,
  fields?: Record<string, unknown>
) => void

export type HrcViewerOptions = {
  client: HrcViewerClient
  ghostmux: ViewerGhostmux
  log?: ViewerLog | undefined
  lingerSeconds?: number | undefined
  reconcileIntervalMs?: number | undefined
  reconnectDelaysMs?: readonly number[] | undefined
  now?: (() => number) | undefined
  schedule?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined
  clearScheduled?: ((handle: ReturnType<typeof setTimeout>) => void) | undefined
}

const DEFAULT_LINGER_SECONDS = 300
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60 * 1_000
const DEFAULT_RECONNECT_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000] as const
const TERMINAL_EVENT_KINDS = new Set([
  'runtime.terminated',
  'runtime.dead',
  'runtime.stale',
  'runtime.crashed',
])

export function parseViewerLingerSeconds(
  value = process.env['HRC_VIEWER_LINGER_SECONDS'],
  fallback = DEFAULT_LINGER_SECONDS
): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function attachCommandFor(row: PresentationRuntimeRow, lingerSeconds: number): string | null {
  if (row.tmux === undefined) return null
  return [
    `tmux -S ${shellQuote(row.tmux.socketPath)} attach-session -t ${shellQuote(row.tmux.attachTarget)}`,
    `hrc monitor session-report --runtime ${shellQuote(row.runtimeId)} --scope ${shellQuote(row.scopeRef)} --wait-key --wait-timeout ${lingerSeconds}`,
    'exit',
  ].join('; ')
}

function titleFor(row: Pick<PresentationRuntimeRow, 'scopeRef' | 'laneRef' | 'title'>): string {
  return row.title ?? defaultHeadlessPaneTitle(row.scopeRef, row.laneRef)
}

function eventTimeMs(event: LifecycleEvent): number | undefined {
  const parsed = Date.parse(event.ts)
  return Number.isFinite(parsed) ? parsed : undefined
}

function paneKeyFor(row: Pick<PresentationRuntimeRow, 'scopeRef' | 'laneRef'>): string {
  return deriveHeadlessSessionIdentity(row.scopeRef, row.laneRef).paneKey
}

function latestByRuntime(events: LifecycleEvent[]): Map<string, LifecycleEvent> {
  const map = new Map<string, LifecycleEvent>()
  for (const event of events) {
    if (event.runtimeId !== undefined) map.set(event.runtimeId, event)
  }
  return map
}

/** Event-driven, stateless presentation projection described by sidecar law §4. */
export class HrcViewer {
  private readonly client: HrcViewerClient
  private readonly ghostmux: ViewerGhostmux
  private readonly log: ViewerLog
  private readonly lingerSeconds: number
  private readonly reconcileIntervalMs: number
  private readonly reconnectDelaysMs: readonly number[]
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearScheduled: (handle: ReturnType<typeof setTimeout>) => void
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly absentSince = new Map<string, number>()
  private reconcileInFlight: Promise<void> | undefined
  private stopped = false
  private readonly statusProjector: HeadlessViewerStatusProjector

  constructor(options: HrcViewerOptions) {
    this.client = options.client
    this.ghostmux = options.ghostmux
    this.log = options.log ?? (() => undefined)
    this.lingerSeconds =
      options.lingerSeconds ?? parseViewerLingerSeconds(process.env['HRC_VIEWER_LINGER_SECONDS'])
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearScheduled = options.clearScheduled ?? ((handle) => clearTimeout(handle))
    this.statusProjector = new HeadlessViewerStatusProjector({
      resolveSurfaceId: (runtimeId) =>
        this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(runtimeId),
      applyStatusBar: (surfaceId, spec) => this.ghostmux.setStatusBar(surfaceId, spec),
      resolveSlug: defaultTaskSlugResolver(),
      onError: (error) => this.warn('broker_headless_viewer.status_failed', error),
    })
  }

  async run(signal?: AbortSignal | undefined): Promise<void> {
    this.stopped = false
    const stop = () => {
      this.stopped = true
    }
    signal?.addEventListener('abort', stop, { once: true })
    const reconcileTimer = setInterval(() => void this.reconcile('timer'), this.reconcileIntervalMs)
    if (typeof reconcileTimer === 'object' && 'unref' in reconcileTimer) reconcileTimer.unref()

    let failures = 0
    try {
      while (!this.isStopped(signal)) {
        try {
          await this.client.health()
          const tail = await this.client.tailEvents({ limit: 1 })
          await this.reconcile(failures === 0 ? 'start' : 'reconnect')
          failures = 0
          await this.consumeStream(tail, signal)
          if (!this.isStopped(signal)) {
            throw new Error('bounded event stream closed')
          }
        } catch (error) {
          if (this.isStopped(signal)) break
          this.warn('broker_headless_viewer.stream_failed', error)
          const index = Math.min(failures, this.reconnectDelaysMs.length - 1)
          const delayMs = this.reconnectDelaysMs[index] ?? 4_000
          failures += 1
          await this.delay(delayMs, signal)
        }
      }
    } finally {
      this.stopped = true
      clearInterval(reconcileTimer)
      signal?.removeEventListener('abort', stop)
      this.statusProjector.dispose()
      for (const timer of this.reapTimers.values()) this.clearScheduled(timer)
      this.reapTimers.clear()
    }
  }

  async reconcile(reason: 'start' | 'reconnect' | 'timer' | 'stream_reset'): Promise<void> {
    if (this.reconcileInFlight !== undefined) return this.reconcileInFlight
    const operation = this.reconcileOnce(reason).finally(() => {
      if (this.reconcileInFlight === operation) this.reconcileInFlight = undefined
    })
    this.reconcileInFlight = operation
    return operation
  }

  async handleEvent(event: LifecycleEvent): Promise<void> {
    this.statusProjector.observe(event)

    if (event.eventKind === 'runtime.presentation') {
      await this.handlePresentationEvent(event)
      return
    }
    if (event.eventKind === 'session.retitled') {
      await this.handleRetitleEvent(event)
      return
    }
    if (TERMINAL_EVENT_KINDS.has(event.eventKind) && event.runtimeId !== undefined) {
      const surfaceId = await this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(event.runtimeId)
      if (surfaceId !== null) {
        const occurredAt = eventTimeMs(event) ?? this.now()
        this.scheduleReap(surfaceId, event.runtimeId, event.scopeRef, occurredAt)
      }
    }
  }

  private async consumeStream(tail: HrcEventTail, signal?: AbortSignal): Promise<void> {
    const expectedIncarnation = tail.ledgerIncarnationId
    let afterSeq = tail.headHrcSeq
    for await (const record of this.client.watchBoundedEvents({
      ledgerIncarnationId: expectedIncarnation,
      afterSeq,
      ...(signal !== undefined ? { signal } : {}),
    })) {
      if (record.type === 'ledger_replaced') {
        this.log('WARN', 'broker_headless_viewer.ledger_replaced', {
          expectedLedgerIncarnationId: record.expectedLedgerIncarnationId,
          currentLedgerIncarnationId: record.currentLedgerIncarnationId,
        })
        await this.reconcile('stream_reset')
        return
      }
      if (record.ledgerIncarnationId !== expectedIncarnation) {
        throw new Error('bounded stream incarnation changed without ledger_replaced')
      }
      if (record.type === 'ready') {
        if (record.acceptedAfterHrcSeq !== afterSeq) {
          throw new Error('bounded stream admitted a different start position')
        }
        continue
      }
      if (record.type === 'gap') {
        this.log('WARN', 'broker_headless_viewer.stream_gap', {
          reason: record.reason,
          afterHrcSeq: record.afterHrcSeq,
          beforeHrcSeq: record.beforeHrcSeq,
          dropped: record.dropped,
        })
        await this.reconcile('stream_reset')
        return
      }
      afterSeq = record.event.hrcSeq
      try {
        await this.handleEvent(record.event)
      } catch (error) {
        this.warn('broker_headless_viewer.event_failed', error, {
          eventKind: record.event.eventKind,
          hrcSeq: record.event.hrcSeq,
        })
      }
    }
  }

  private async handlePresentationEvent(event: LifecycleEvent): Promise<void> {
    const payload = asRecord(event.payload)
    const invocation = asRecord(payload['invocation'])
    const presentation = asRecord(payload['presentation'])
    if (invocation['operatorAttachPending'] === true) {
      this.log('INFO', 'broker_headless_viewer.skipped_operator_attach_pending', {
        runtimeId: event.runtimeId,
        scopeRef: event.scopeRef,
      })
      return
    }
    if (presentation['operatorAttachable'] !== true) {
      this.log('INFO', 'broker_headless_viewer.skipped_no_presentation', {
        runtimeId: event.runtimeId,
        scopeRef: event.scopeRef,
      })
      return
    }
    const tmux = asRecord(payload['tmux'])
    const socketPath = typeof tmux['socketPath'] === 'string' ? tmux['socketPath'] : undefined
    const attachTarget = typeof tmux['attachTarget'] === 'string' ? tmux['attachTarget'] : undefined
    if (event.runtimeId === undefined || socketPath === undefined || attachTarget === undefined) {
      this.log('INFO', 'broker_headless_viewer.skipped_no_socket', {
        runtimeId: event.runtimeId,
        scopeRef: event.scopeRef,
      })
      return
    }
    await this.ensurePane({
      runtimeId: event.runtimeId,
      hostSessionId: event.hostSessionId,
      scopeRef: event.scopeRef,
      laneRef: event.laneRef,
      generation: event.generation,
      status: 'busy',
      presentation: {
        operatorAttachable: true,
        viewerRequested: presentation['viewerRequested'] === true,
        ...(typeof presentation['viewerWindow'] === 'string'
          ? { viewerWindow: presentation['viewerWindow'] }
          : {}),
      },
      tmux: { socketPath, attachTarget },
      ...(typeof payload['title'] === 'string' ? { title: payload['title'] } : {}),
    })
  }

  private async handleRetitleEvent(event: LifecycleEvent): Promise<void> {
    const payload = asRecord(event.payload)
    const requestedTitle = typeof payload['title'] === 'string' ? payload['title'] : undefined
    const title = requestedTitle ?? defaultHeadlessPaneTitle(event.scopeRef, event.laneRef)
    const paneKey = deriveHeadlessSessionIdentity(event.scopeRef, event.laneRef).paneKey
    const panes = await this.ghostmux.listHeadlessViewerPanes()
    const pane = panes.find(
      (candidate) =>
        candidate.hostSessionId === event.hostSessionId || candidate.paneKey === paneKey
    )
    if (pane !== undefined) await this.ghostmux.setHeadlessViewerTitle(pane.surfaceId, title)
  }

  private async reconcileOnce(reason: string): Promise<void> {
    try {
      const [response, latest, panes] = await Promise.all([
        this.client.listPresentationRuntimes(),
        this.client.listLatestEventBySession(),
        this.ghostmux.listHeadlessViewerPanes(),
      ])
      const rows = response.runtimes
      const rowsByRuntime = new Map(rows.map((row) => [row.runtimeId, row]))
      const rowsByPaneKey = new Map(rows.map((row) => [paneKeyFor(row), row]))
      const eventsByRuntime = latestByRuntime(latest)
      const adoptedSurfaceIds = new Set<string>()

      for (const pane of panes) {
        const direct = pane.runtimeId === undefined ? undefined : rowsByRuntime.get(pane.runtimeId)
        const replacement = pane.paneKey === undefined ? undefined : rowsByPaneKey.get(pane.paneKey)
        const row = direct ?? replacement
        if (row !== undefined) {
          this.absentSince.delete(pane.runtimeId ?? row.runtimeId)
          adoptedSurfaceIds.add(pane.surfaceId)
          if (
            pane.runtimeId !== row.runtimeId ||
            pane.hostSessionId !== row.hostSessionId ||
            pane.generation !== row.generation
          ) {
            await this.ghostmux.rebindHeadlessViewerPane(pane.surfaceId, {
              scopeRef: row.scopeRef,
              laneRef: row.laneRef,
              runtimeId: row.runtimeId,
              hostSessionId: row.hostSessionId,
              generation: row.generation,
              windowKey: row.presentation?.viewerWindow,
            })
          }
          await this.ghostmux.setHeadlessViewerTitle(pane.surfaceId, titleFor(row))
          await this.paintFromLatest(pane.surfaceId, row, eventsByRuntime.get(row.runtimeId))
          continue
        }

        if (pane.runtimeId === undefined) continue
        const latestEvent = eventsByRuntime.get(pane.runtimeId)
        const terminalAt =
          latestEvent !== undefined && TERMINAL_EVENT_KINDS.has(latestEvent.eventKind)
            ? (eventTimeMs(latestEvent) ?? this.now())
            : (this.absentSince.get(pane.runtimeId) ?? this.now())
        this.absentSince.set(pane.runtimeId, terminalAt)
        this.scheduleReap(
          pane.surfaceId,
          pane.runtimeId,
          pane.scopeRef ?? latestEvent?.scopeRef ?? 'unknown',
          terminalAt
        )
      }

      for (const row of rows) {
        const pane = panes.find(
          (candidate) =>
            adoptedSurfaceIds.has(candidate.surfaceId) &&
            (candidate.runtimeId === row.runtimeId || candidate.paneKey === paneKeyFor(row))
        )
        if (pane !== undefined) continue
        // Upgrade law §5.5: a missing record is adopt-only. Never infer intent.
        if (
          row.presentation?.viewerRequested !== true ||
          row.presentation.operatorAttachable !== true ||
          row.tmux === undefined
        ) {
          continue
        }
        await this.ensurePane(row, eventsByRuntime.get(row.runtimeId))
      }
      this.log('INFO', 'broker_headless_viewer.reconciled', {
        reason,
        runtimes: rows.length,
        panes: panes.length,
      })
    } catch (error) {
      this.warn('broker_headless_viewer.reconcile_failed', error, { reason })
    }
  }

  private async ensurePane(
    row: PresentationRuntimeRow,
    latestEvent?: LifecycleEvent | undefined
  ): Promise<void> {
    const attachCommand = attachCommandFor(row, this.lingerSeconds)
    if (attachCommand === null) return
    const slug = await defaultTaskSlugResolver()(row.scopeRef)
    const state = latestEvent ? (viewerStateForEventKind(latestEvent.eventKind) ?? 'idle') : 'idle'
    const result = await this.ghostmux.ensureHeadlessViewer({
      scopeRef: row.scopeRef,
      laneRef: row.laneRef,
      runtimeId: row.runtimeId,
      hostSessionId: row.hostSessionId,
      generation: row.generation,
      attachCommand,
      title: titleFor(row),
      statusBar: renderStatusBar(row.scopeRef, state, slug, row.laneRef),
      terminalBg: viewerTerminalBg(row.scopeRef),
      windowKey: row.presentation?.viewerWindow,
    })
    this.log(
      result.status === 'failed' ? 'WARN' : 'INFO',
      `broker_headless_viewer.${result.status}`,
      {
        runtimeId: row.runtimeId,
        scopeRef: row.scopeRef,
        ...(result.status === 'failed' ? { error: result.error } : { surfaceId: result.surfaceId }),
      }
    )
  }

  private async paintFromLatest(
    surfaceId: string,
    row: PresentationRuntimeRow,
    event: LifecycleEvent | undefined
  ): Promise<void> {
    const state = event ? viewerStateForEventKind(event.eventKind) : null
    if (state === null) return
    const slug = await defaultTaskSlugResolver()(row.scopeRef)
    await this.ghostmux.setStatusBar(
      surfaceId,
      renderStatusBar(row.scopeRef, state, slug, row.laneRef)
    )
  }

  private scheduleReap(
    surfaceId: string,
    runtimeId: string,
    scopeRef: string,
    terminalAtMs: number
  ): void {
    if (this.reapTimers.has(runtimeId)) return
    const remainingMs = Math.max(0, terminalAtMs + this.lingerSeconds * 1_000 - this.now())
    this.log('INFO', 'headless_viewer_reap.linger_scheduled', {
      runtimeId,
      scopeRef,
      surfaceId,
      lingerSeconds: Math.ceil(remainingMs / 1_000),
    })
    const timer = this.schedule(() => {
      this.reapTimers.delete(runtimeId)
      void this.reap(surfaceId, runtimeId, scopeRef)
    }, remainingMs)
    this.reapTimers.set(runtimeId, timer)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
  }

  private async reap(surfaceId: string, runtimeId: string, scopeRef: string): Promise<void> {
    try {
      const result = await this.ghostmux.reapHeadlessAgentPane(surfaceId, runtimeId)
      this.log(
        result.status === 'failed' ? 'WARN' : 'INFO',
        `headless_viewer_reap.${result.status}`,
        {
          runtimeId,
          scopeRef,
          surfaceId,
          ...(result.status === 'reaped' ? { tabCollapsed: result.tabCollapsed } : {}),
          ...(result.status === 'skipped' ? { reason: result.reason } : {}),
          ...(result.status === 'failed' ? { error: result.error } : {}),
        }
      )
    } catch (error) {
      this.warn('headless_viewer_reap.unexpected_error', error, { runtimeId, scopeRef, surfaceId })
    }
  }

  private warn(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
    this.log('WARN', event, {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted === true) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
    })
  }

  private isStopped(signal?: AbortSignal): boolean {
    return this.stopped || signal?.aborted === true
  }
}
