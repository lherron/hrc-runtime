import type { HrcClient, HrcEventTail } from 'hrc-sdk'

import {
  type GhostmuxSecondaryStatusBarSpec,
  type GhostmuxStatusBarSpec,
  type HeadlessReapResult,
  type HeadlessViewerPane,
  type HeadlessViewerResult,
  defaultHeadlessPaneTitle,
  deriveHeadlessSessionIdentity,
} from './ghostmux.js'
import {
  HeadlessViewerStatusProjector,
  renderSecondaryStatusBar,
  renderStatusBar,
  viewerStateForEventKind,
  viewerTerminalBg,
} from './headless-viewer-status.js'
import { type TmuxClientProbe, createTmuxClientProbe } from './tmux-clients.js'
import {
  type TaskTitleReader,
  defaultTaskSlugResolver,
  defaultTaskTitleReader,
  extractTaskIdFromScope,
} from './wrkq-task-label.js'

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
    skipCreateWhen?: (() => Promise<boolean>) | undefined
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
  setSecondaryStatusBar(surfaceId: string, spec: GhostmuxSecondaryStatusBarSpec): Promise<void>
  hideSecondaryStatusBar(surfaceId: string): Promise<void>
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
  /**
   * Who is already attached to a runtime's tmux target (T-07711). Injected so
   * the operator-attached suppression is testable without a live tmux server.
   */
  probeTmuxClients?: TmuxClientProbe | undefined
  /** Batched wrkq task-title reader for the secondary bar (T-08331). Injected for tests. */
  readTaskTitles?: TaskTitleReader | undefined
}

const DEFAULT_LINGER_SECONDS = 300
/**
 * How much longer the pane waits before closing itself than the reaper waits
 * before closing it (T-08115).
 *
 * The pane's own command ends `session-report --wait-timeout <linger>; exit`,
 * and `scheduleReap` fires at `terminalAt + <linger>`. Given the same number,
 * those are the SAME deadline: the pane's clock starts when `tmux attach`
 * returns, which is the terminal event the reaper is also counting from. The
 * two were separated only by process-startup jitter, so which one closed the
 * pane was a coin flip — measured on 2026-09-06, the reaper won by 0.6s for
 * rt-49e5932f and lost five other races the same hour. Losing cost the fenced
 * reap its tab-collapse bookkeeping and logged a skip for a pane that had in
 * fact gone. A margin makes the reaper authoritative and leaves the pane's own
 * exit as the backstop for when the viewer is not running at all.
 */
const REAP_HANDOFF_MARGIN_SECONDS = 15
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

function normalizePresentationLaneRef(laneRef: string | undefined): string {
  if (laneRef === undefined || laneRef === '' || laneRef === 'main' || laneRef === 'lane:main') {
    return 'main'
  }
  return laneRef.startsWith('lane:') ? laneRef : `lane:${laneRef}`
}

function attachCommandFor(row: PresentationRuntimeRow, lingerSeconds: number): string | null {
  if (row.tmux === undefined) return null
  return [
    `tmux -S ${shellQuote(row.tmux.socketPath)} attach-session -t ${shellQuote(row.tmux.attachTarget)}`,
    `hrc monitor session-report --runtime ${shellQuote(row.runtimeId)} --scope ${shellQuote(row.scopeRef)} --wait-key --wait-timeout ${lingerSeconds + REAP_HANDOFF_MARGIN_SECONDS}`,
    'exit',
  ].join('; ')
}

function titleFor(row: Pick<PresentationRuntimeRow, 'scopeRef' | 'laneRef' | 'title'>): string {
  return (
    row.title ?? defaultHeadlessPaneTitle(row.scopeRef, normalizePresentationLaneRef(row.laneRef))
  )
}

function eventTimeMs(event: LifecycleEvent): number | undefined {
  const parsed = Date.parse(event.ts)
  return Number.isFinite(parsed) ? parsed : undefined
}

function paneKeyFor(row: Pick<PresentationRuntimeRow, 'scopeRef' | 'laneRef'>): string {
  return deriveHeadlessSessionIdentity(row.scopeRef, normalizePresentationLaneRef(row.laneRef))
    .paneKey
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
  private readonly probeTmuxClients: TmuxClientProbe
  private readonly readTaskTitles: TaskTitleReader
  /**
   * Last-known wrkq title per task id (T-08331). Refreshed in one batched read
   * per reconcile and NEVER evicted on a read failure — a deleted task, a wrkq
   * missing from PATH or a hung CLI must degrade to the title already on the
   * bar, never blank every pane at once.
   */
  private readonly taskTitles = new Map<string, string>()

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
    this.probeTmuxClients = options.probeTmuxClients ?? createTmuxClientProbe()
    this.readTaskTitles = options.readTaskTitles ?? defaultTaskTitleReader()
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
        // The task title describes a LIVE seat. A pane lingers for minutes after
        // its runtime ends and may be recycled for another occupant, so drop the
        // title at the terminal event rather than leaving it up until the reap.
        await this.clearSecondaryBar(surfaceId)
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
    if (presentation['viewerRequested'] !== true || presentation['operatorAttachable'] !== true) {
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
      laneRef: normalizePresentationLaneRef(event.laneRef),
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
    const laneRef = normalizePresentationLaneRef(event.laneRef)
    const title = requestedTitle ?? defaultHeadlessPaneTitle(event.scopeRef, laneRef)
    const paneKey = deriveHeadlessSessionIdentity(event.scopeRef, laneRef).paneKey
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
      // One batched read for the whole fleet, BEFORE any pane is stamped, so
      // every pane in this pass is titled from the same fresh answer.
      await this.refreshTaskTitles(rows.map((row) => row.scopeRef))

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
              laneRef: normalizePresentationLaneRef(row.laneRef),
              runtimeId: row.runtimeId,
              hostSessionId: row.hostSessionId,
              generation: row.generation,
              windowKey: row.presentation?.viewerWindow,
            })
          }
          await this.ghostmux.setHeadlessViewerTitle(pane.surfaceId, titleFor(row))
          await this.paintFromLatest(pane.surfaceId, row, eventsByRuntime.get(row.runtimeId))
          // Deliberately OUTSIDE paintFromLatest: the secondary bar is
          // fact-driven, and paintFromLatest returns early for a runtime whose
          // latest event carries no state. A pane mid-turn on an unmapped kind
          // gets no primary repaint at all, and must still be retitled here.
          await this.applySecondaryBar(pane.surfaceId, row.scopeRef)
          continue
        }

        // No presentation row: this pane is terminal or orphaned and is headed
        // for the reaper. Same reason as the terminal-event path above.
        await this.clearSecondaryBar(pane.surfaceId)
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
    const tmux = row.tmux
    const attachCommand = attachCommandFor(row, this.lingerSeconds)
    if (attachCommand === null || tmux === undefined) return
    const slug = await defaultTaskSlugResolver()(row.scopeRef)
    const state = latestEvent ? (viewerStateForEventKind(latestEvent.eventKind) ?? 'idle') : 'idle'
    // T-07711: captured by the veto below so the skip can NAME the terminals it
    // deferred to. A reclassified case has to leave a positive line — proving
    // the fix by the absence of a `created` line proves nothing.
    let operatorClients: readonly string[] = []
    const result = await this.ghostmux.ensureHeadlessViewer({
      scopeRef: row.scopeRef,
      laneRef: normalizePresentationLaneRef(row.laneRef),
      runtimeId: row.runtimeId,
      hostSessionId: row.hostSessionId,
      generation: row.generation,
      attachCommand,
      title: titleFor(row),
      statusBar: renderStatusBar(
        row.scopeRef,
        state,
        slug,
        normalizePresentationLaneRef(row.laneRef)
      ),
      terminalBg: viewerTerminalBg(row.scopeRef),
      windowKey: row.presentation?.viewerWindow,
      // Only reached when no pane of ours exists for this identity, so every
      // attached client is somebody ELSE's terminal — an operator watching this
      // runtime via `hrc run`/`hrc attach`. Fails open: the probe answers `[]`
      // for every error, dead socket and timeout, and the create proceeds.
      skipCreateWhen: async () => {
        operatorClients = await this.probeTmuxClients(tmux.socketPath, tmux.attachTarget)
        return operatorClients.length > 0
      },
    })
    if (result.status === 'skipped') {
      this.log('INFO', 'broker_headless_viewer.skipped_operator_attached', {
        runtimeId: row.runtimeId,
        scopeRef: row.scopeRef,
        attachTarget: tmux.attachTarget,
        clients: operatorClients,
      })
      return
    }
    if (result.status === 'created' || result.status === 'reused') {
      // Fire-and-forget: a title read must never delay or fail pane creation.
      void this.stampSecondaryBarFresh(result.surfaceId, row.scopeRef)
    }
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
      renderStatusBar(row.scopeRef, state, slug, normalizePresentationLaneRef(row.laneRef))
    )
  }

  /**
   * Refresh last-known titles for every task carried by these scopes, in ONE
   * batched `wrkq cat`. Never throws and never evicts: an id the read could not
   * resolve keeps whatever title it already had, so a single deleted task can
   * not blank the fleet.
   */
  private async refreshTaskTitles(scopeRefs: readonly string[]): Promise<void> {
    const taskIds = new Set<string>()
    for (const scopeRef of scopeRefs) {
      const taskId = extractTaskIdFromScope(scopeRef)
      if (taskId !== null) taskIds.add(taskId)
    }
    if (taskIds.size === 0) return
    try {
      const titles = await this.readTaskTitles([...taskIds])
      for (const [taskId, title] of titles) this.taskTitles.set(taskId, title)
    } catch (error) {
      this.warn('broker_headless_viewer.task_titles_failed', error)
    }
  }

  /**
   * Stamp (or hide) the secondary bar for one pane from the last-known titles.
   * Cosmetic and total: it never throws, never delays lifecycle work, and never
   * clears a bar it merely failed to read — a task-scoped pane with no known
   * title is left exactly as it is, so a wrkq outage degrades to a stale title
   * rather than a blank one. `:primary` and lane-only seats carry no task, so
   * they are HIDDEN rather than skipped: a recycled pane would otherwise keep
   * its previous occupant's title.
   */
  private async applySecondaryBar(surfaceId: string, scopeRef: string): Promise<void> {
    try {
      const taskId = extractTaskIdFromScope(scopeRef)
      if (taskId === null) {
        await this.ghostmux.hideSecondaryStatusBar(surfaceId)
        return
      }
      const title = this.taskTitles.get(taskId)
      if (title === undefined) return
      const spec = renderSecondaryStatusBar(title)
      if (spec === null) return
      await this.ghostmux.setSecondaryStatusBar(surfaceId, spec)
    } catch (error) {
      this.warn('broker_headless_viewer.secondary_status_failed', error, { surfaceId, scopeRef })
    }
  }

  /** Read the title first when this task has never been seen, then stamp. */
  private async stampSecondaryBarFresh(surfaceId: string, scopeRef: string): Promise<void> {
    const taskId = extractTaskIdFromScope(scopeRef)
    if (taskId !== null && !this.taskTitles.has(taskId)) await this.refreshTaskTitles([scopeRef])
    await this.applySecondaryBar(surfaceId, scopeRef)
  }

  /** Drop the title bar from a pane whose seat is gone. Never throws. */
  private async clearSecondaryBar(surfaceId: string): Promise<void> {
    try {
      await this.ghostmux.hideSecondaryStatusBar(surfaceId)
    } catch (error) {
      this.warn('broker_headless_viewer.secondary_status_failed', error, { surfaceId })
    }
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
          // T-08115: a skip must say what it observed against what it required,
          // so the NEXT occurrence is self-diagnosing from the log alone.
          ...(result.status === 'skipped'
            ? {
                reason: result.reason,
                ...(result.observedRole !== undefined ? { observedRole: result.observedRole } : {}),
                ...(result.requiredRole !== undefined ? { requiredRole: result.requiredRole } : {}),
                ...(result.observedRuntimeId !== undefined
                  ? { observedRuntimeId: result.observedRuntimeId }
                  : {}),
                ...(result.requiredRuntimeId !== undefined
                  ? { requiredRuntimeId: result.requiredRuntimeId }
                  : {}),
                ...(result.probeError !== undefined ? { probeError: result.probeError } : {}),
              }
            : {}),
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
