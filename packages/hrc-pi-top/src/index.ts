import {
  type Component,
  Input,
  ProcessTerminal,
  TUI,
  type Terminal,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
} from '@earendil-works/pi-tui'
import type { HrcLifecycleEvent } from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import type { WatchOptions } from 'hrc-sdk'
import {
  type HrcTopActionDetail,
  type HrcTopActionExecutor,
  type HrcTopActionResult,
  type HrcTopActionTargetIdentity,
  type HrcTopAmbiguityAction,
  type HrcTopAmbiguityCandidate,
  type HrcTopAmbiguitySourceIdentity,
  type HrcTopExplicitAction,
  type HrcTopKeyIntent,
  type HrcTopKeyPrefix,
  type HrcTopNavState,
  type HrcTopOptions,
  type HrcTopReadModel,
  type HrcTopRow,
  type HrcTopScope,
  ambiguityGroupForRow,
  buildHrcTopAmbiguityModel,
  candidatesForAmbiguousAction,
  createHrcTopActionExecutor,
  createNavState,
  dispatchHrcTopActionKey,
  executeHrcTopCommandLine,
  handleForRow,
  loadReadModel,
  reduceNavState,
  renderTopScreen,
  runHrcTop,
  sameAmbiguitySource,
  selectVisibleTriageRowIds,
} from 'hrc-top'

type HrcPiTopClient = Pick<HrcClient, 'listTargets'> &
  Partial<Pick<HrcClient, 'attachRuntime' | 'watch'>>

type EventTailPreviewState = {
  rowId: string
  handle: string
  events: HrcLifecycleEvent[]
  error?: string | undefined
}

type RunConfirmationOverlayState = {
  rowId: string
  handle: string
  continuationText?: string | undefined
}

type AmbiguityResolverOverlayState = {
  originRowId?: string | undefined
  handle: string
  action: HrcTopAmbiguityAction
  candidates: readonly HrcTopAmbiguityCandidate[]
  selectedIndex: number
}

type ActionDetailOverlayState = {
  action: HrcTopExplicitAction | undefined
  status: HrcTopActionResult['status']
  reason?: string | undefined
  errorCode?: string | undefined
  detail: HrcTopActionDetail
  open: boolean
}

export type HrcPiTopOptions = HrcTopOptions & {
  terminal?: Terminal | undefined
}

export type HrcPiTopAppOptions = {
  client: HrcPiTopClient
  executor: HrcTopActionExecutor
  initialModel: HrcTopReadModel
  scope: HrcTopScope
  viewportHeight: () => number
  requestRender: () => void
  onQuit: () => void
  isSuspended?: (() => boolean) | undefined
}

type HrcPiTopRestoreInputListener = (data: string) => boolean | undefined

type HrcPiTopRestoreTui = {
  readonly started: boolean
  start(): void
  stop(): void
  addInputListener(listener: HrcPiTopRestoreInputListener): () => void
  requestRender(force?: boolean): void
}

type HrcPiTopRestoreApp = {
  invalidate(): void
}

export type HrcPiTopSpawnRestoreCoordinator = {
  beforeSpawn(): void
  afterSpawn(): void
  isSuspended(): boolean
  close(): void
}

export function createHrcPiTopSpawnRestoreCoordinator(input: {
  tui: HrcPiTopRestoreTui
  app: HrcPiTopRestoreApp
  restoreIdleMs?: number | undefined
}): HrcPiTopSpawnRestoreCoordinator {
  let closed = false
  let suspended = false
  let restorePending = false
  let disposeRestoreListener: (() => void) | undefined
  let restoreIdleTimer: ReturnType<typeof setTimeout> | undefined

  const clearRestoreIdleTimer = () => {
    if (!restoreIdleTimer) return
    clearTimeout(restoreIdleTimer)
    restoreIdleTimer = undefined
  }

  const clearRestoreListener = () => {
    clearRestoreIdleTimer()
    disposeRestoreListener?.()
    disposeRestoreListener = undefined
  }

  const completeRestoreFiltering = () => {
    clearRestoreListener()
  }

  const installRestoreListener = () => {
    clearRestoreListener()
    disposeRestoreListener = input.tui.addInputListener((data) => {
      if (isHrcPiTopRestoreTerminalReport(data)) {
        scheduleRestoreIdleCleanup()
        return true
      }
      completeRestoreFiltering()
      return undefined
    })
  }

  const scheduleRestoreIdleCleanup = () => {
    clearRestoreIdleTimer()
    const timer = setTimeout(() => {
      restoreIdleTimer = undefined
      disposeRestoreListener?.()
      disposeRestoreListener = undefined
    }, input.restoreIdleMs ?? 50)
    timer.unref?.()
    restoreIdleTimer = timer
  }

  return {
    beforeSpawn(): void {
      if (closed) return
      clearRestoreListener()
      if (!restorePending && input.tui.started) {
        input.tui.stop()
      }
      suspended = true
      restorePending = true
    },

    afterSpawn(): void {
      if (!restorePending) return
      restorePending = false
      if (closed) {
        suspended = false
        clearRestoreListener()
        return
      }

      installRestoreListener()
      input.tui.start()
      suspended = false
      input.app.invalidate()
      input.tui.requestRender(true)
      scheduleRestoreIdleCleanup()
    },

    isSuspended(): boolean {
      return suspended
    },

    close(): void {
      closed = true
      suspended = false
      restorePending = false
      clearRestoreListener()
    },
  }
}

export async function runHrcPiTop(options: HrcPiTopOptions = {}): Promise<void> {
  if (!options.terminal && !isInteractiveProcess(options)) {
    await runHrcTop(options)
    return
  }

  const client = options.client ?? new HrcClient(options.socketPath ?? discoverSocket())
  const terminal = options.terminal ?? new ProcessTerminal()
  const model = await loadReadModel(client, options)
  const tui = new TUI(terminal)

  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  let started = false
  let resolveClosed: (() => void) | undefined
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const appRef: { current?: HrcPiTopApp | undefined } = {}
  const spawnRestore = createHrcPiTopSpawnRestoreCoordinator({
    tui: {
      get started() {
        return started
      },
      start() {
        tui.start()
        started = true
      },
      stop() {
        tui.stop()
        started = false
      },
      addInputListener(listener) {
        return tui.addInputListener((data) => (listener(data) ? { consume: true } : undefined))
      },
      requestRender(force) {
        tui.requestRender(force)
      },
    },
    app: {
      invalidate() {
        appRef.current?.invalidate()
      },
    },
  })

  const stop = () => {
    if (closed) return
    closed = true
    spawnRestore.close()
    if (timer) clearInterval(timer)
    timer = undefined
    if (started) {
      started = false
      tui.stop()
    }
    resolveClosed?.()
  }

  const executor = createHrcTopActionExecutor(requireActionClient(client), {
    beforeSpawn: () => spawnRestore.beforeSpawn(),
    afterSpawn: () => spawnRestore.afterSpawn(),
  })

  const app = new HrcPiTopApp({
    client,
    executor,
    initialModel: model,
    scope: options,
    viewportHeight: () => terminal.rows,
    requestRender: () => tui.requestRender(),
    onQuit: stop,
    isSuspended: () => spawnRestore.isSuspended(),
  })
  appRef.current = app

  tui.addChild(app)
  tui.setFocus(app)

  try {
    tui.start()
    started = true
    timer = setInterval(
      () => {
        void app.refresh()
      },
      Math.max(500, options.pollIntervalMs ?? 3_000)
    )
    await closedPromise
  } finally {
    stop()
  }
}

export class HrcPiTopApp implements Component {
  private readonly client: HrcPiTopClient
  private readonly executor: HrcTopActionExecutor
  private readonly scope: HrcTopScope
  private readonly viewportHeight: () => number
  private readonly requestRender: () => void
  private readonly onQuit: () => void
  private readonly isSuspended: () => boolean
  private readonly filterInput = new Input()
  private readonly commandInput = new Input()

  private model: HrcTopReadModel
  private navState: HrcTopNavState
  private focusMode = false
  private inspectMode = false
  private showAll = false
  private showHelp = false
  private filterText = ''
  private filterMode = false
  private commandMode = false
  private notice: string | undefined
  private eventTailPreview: EventTailPreviewState | undefined
  private runConfirmationOverlay: RunConfirmationOverlayState | undefined
  private ambiguityResolver: AmbiguityResolverOverlayState | undefined
  private actionDetailOverlay: ActionDetailOverlayState | undefined
  private inspectCandidateRow: HrcTopRow | undefined
  private keyPrefix: HrcTopKeyPrefix
  private pendingAction: Promise<void> = Promise.resolve()

  constructor(options: HrcPiTopAppOptions) {
    this.client = options.client
    this.executor = options.executor
    this.model = options.initialModel
    this.scope = options.scope
    this.viewportHeight = options.viewportHeight
    this.requestRender = options.requestRender
    this.onQuit = options.onQuit
    this.isSuspended = options.isSuspended ?? (() => false)
    this.navState = createNavState({
      visibleRows: this.visibleRows(),
      viewportHeight: this.height(),
    })

    this.filterInput.onSubmit = () => {
      this.filterMode = false
      this.filterText = this.filterInput.getValue()
      this.recomputeNav()
      this.requestRender()
    }
    this.filterInput.onEscape = () => {
      this.filterMode = false
      this.filterText = this.filterInput.getValue()
      this.recomputeNav()
      this.requestRender()
    }
    this.commandInput.onSubmit = (value) => {
      this.commandMode = false
      this.commandInput.setValue('')
      this.enqueue(() => this.submitCommand(value))
      this.requestRender()
    }
    this.commandInput.onEscape = () => {
      this.commandMode = false
      this.commandInput.setValue('')
      this.requestRender()
    }
  }

  async refresh(): Promise<void> {
    if (this.isSuspended()) return
    try {
      this.model = await loadReadModel(this.client, this.scope)
      this.recomputeNav()
      this.expireRunConfirmationIfStale()
      this.expireAmbiguityResolver(
        'Ambiguity resolver expired after refresh; choose the action again.'
      )
      this.expireActionDetailIfStale()
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error)
    }
    this.requestRender()
  }

  snapshot(): {
    filterText: string
    filterMode: boolean
    commandMode: boolean
    focusMode: boolean
    inspectMode: boolean
    selectedRowId: string | undefined
    notice: string | undefined
    ambiguityResolver: string | undefined
  } {
    return {
      filterText: this.filterText,
      filterMode: this.filterMode,
      commandMode: this.commandMode,
      focusMode: this.focusMode,
      inspectMode: this.inspectMode,
      selectedRowId: this.navState.selectedRowId,
      notice: this.notice,
      ambiguityResolver: this.ambiguityResolver?.action,
    }
  }

  async whenIdle(): Promise<void> {
    await this.pendingAction
  }

  render(width: number): string[] {
    if (this.eventTailPreview) {
      const lines = renderEventTailPreview({
        preview: this.eventTailPreview,
        height: this.height(),
        width,
      })
      if (this.actionDetailOverlay?.open) {
        return renderActionDetailOverlay(lines, this.actionDetailOverlay, this.height(), width)
      }
      if (this.runConfirmationOverlay) {
        return renderRunConfirmationOverlay(
          lines,
          this.runConfirmationOverlay,
          this.height(),
          width
        )
      }
      return this.showHelp ? renderHelpOverlay(lines, this.height(), width) : lines
    }

    const renderState = this.renderModelState()
    const frame = renderTopScreen({
      model: renderState.model,
      navState: renderState.navState,
      viewportHeight: this.height(),
      width,
      filterText: this.filterText,
      filterMode: this.filterMode,
      commandText: this.commandInput.getValue(),
      commandMode: this.commandMode,
      focusMode: this.focusMode,
      inspectMode: this.inspectMode,
      showAll: this.showAll,
      showHelp: false,
      notice: this.notice,
      color: true,
    })

    const lines = splitFrame(frame)
    this.filterInput.focused = this.filterMode
    this.commandInput.focused = this.commandMode

    if (this.filterMode) {
      replaceLine(
        lines,
        (line) => line.startsWith('/'),
        this.renderInputLine('/', this.filterInput, width)
      )
    }
    if (this.commandMode) {
      replaceLine(
        lines,
        (line) => line.startsWith(':'),
        this.renderInputLine(':', this.commandInput, width)
      )
    }

    const rendered = lines.map((line) => truncateToWidth(line, width, '', false))
    if (this.actionDetailOverlay?.open) {
      return renderActionDetailOverlay(rendered, this.actionDetailOverlay, this.height(), width)
    }
    if (this.ambiguityResolver) {
      return renderAmbiguityResolverOverlay(rendered, this.ambiguityResolver, this.height(), width)
    }
    if (this.runConfirmationOverlay) {
      return renderRunConfirmationOverlay(
        rendered,
        this.runConfirmationOverlay,
        this.height(),
        width
      )
    }
    return this.showHelp ? renderHelpOverlay(rendered, this.height(), width) : rendered
  }

  handleInput(data: string): void {
    if (this.isSuspended()) return
    this.notice = undefined

    if (matchesKey(data, 'ctrl+c')) {
      this.onQuit()
      return
    }

    if (this.actionDetailOverlay?.open) {
      this.handleActionDetailOverlayInput(data)
      return
    }

    if (this.runConfirmationOverlay) {
      this.handleRunConfirmationInput(data)
      return
    }

    if (this.ambiguityResolver) {
      this.handleAmbiguityResolverInput(data)
      return
    }

    if (this.showHelp) {
      if (isHelpDismissInput(data)) {
        this.showHelp = false
        this.keyPrefix = undefined
      }
      this.requestRender()
      return
    }

    if (this.commandMode) {
      this.commandInput.handleInput(data)
      this.requestRender()
      return
    }

    if (this.filterMode) {
      this.filterInput.handleInput(data)
      this.filterText = this.filterInput.getValue()
      this.recomputeNav()
      this.requestRender()
      return
    }

    const intent = this.intentForInput(data)
    if (intent) this.handleIntent(intent)
  }

  invalidate(): void {
    this.filterInput.invalidate()
    this.commandInput.invalidate()
  }

  private height(): number {
    return Math.max(8, this.viewportHeight())
  }

  private visibleRows(): { id: string }[] {
    return selectVisibleTriageRowIds(this.model, {
      filterText: this.filterText,
      showAll: this.showAll,
    })
  }

  private renderModelState(): { model: HrcTopReadModel; navState: HrcTopNavState } {
    if (!this.inspectMode || !this.inspectCandidateRow) {
      return { model: this.model, navState: this.navState }
    }
    const exists = this.model.rows.some((row) => row.id === this.inspectCandidateRow?.id)
    const model = exists
      ? this.model
      : { ...this.model, rows: [...this.model.rows, this.inspectCandidateRow] }
    return {
      model,
      navState: {
        ...this.navState,
        selectedRowId: this.inspectCandidateRow.id,
      },
    }
  }

  private recomputeNav(): void {
    this.navState = reduceNavState(
      this.navState,
      { type: 'refresh' },
      {
        visibleRows: this.visibleRows(),
        viewportHeight: this.height(),
      }
    )
  }

  private selectedRow(): HrcTopRow | undefined {
    const selectedId =
      this.navState.selectedRowId ?? this.visibleRows()[this.navState.selectedIndex]?.id
    if (!selectedId) return undefined
    return this.model.rows.find((row) => row.id === selectedId)
  }

  private renderInputLine(prefix: '/' | ':', input: Input, width: number): string {
    const inputWidth = Math.max(1, width - prefix.length)
    const rendered = input.render(inputWidth)[0] ?? ''
    const body = rendered.startsWith('> ') ? rendered.slice(2) : rendered
    return truncateToWidth(`${prefix}${body}`, width, '', false)
  }

  private intentForInput(data: string): HrcTopKeyIntent | undefined {
    const printable = printableInput(data)

    if (this.keyPrefix === 'g') {
      this.keyPrefix = undefined
      return printable === 'g'
        ? { type: 'key', key: 'gg' }
        : { type: 'noop', reason: 'unknown g command' }
    }
    if (this.keyPrefix === 'mark') {
      this.keyPrefix = undefined
      return printable && printable.length === 1
        ? { type: 'mark', name: printable }
        : { type: 'noop', reason: 'mark name must be one character' }
    }
    if (this.keyPrefix === 'jump') {
      this.keyPrefix = undefined
      return printable && printable.length === 1
        ? { type: 'jumpToMark', name: printable }
        : { type: 'noop', reason: 'mark name must be one character' }
    }

    if (matchesKey(data, 'ctrl+d')) return { type: 'key', key: 'ctrl-d' }
    if (matchesKey(data, 'ctrl+u')) return { type: 'key', key: 'ctrl-u' }
    if (matchesKey(data, 'ctrl+f') || matchesKey(data, 'pageDown'))
      return { type: 'key', key: 'ctrl-f' }
    if (matchesKey(data, 'ctrl+b') || matchesKey(data, 'pageUp'))
      return { type: 'key', key: 'ctrl-b' }
    if (matchesKey(data, 'enter') || matchesKey(data, 'return')) return { type: 'focus' }
    if (matchesKey(data, 'down') || printable === 'j') return { type: 'key', key: 'j' }
    if (matchesKey(data, 'up') || printable === 'k') return { type: 'key', key: 'k' }
    if (matchesKey(data, 'home')) return { type: 'key', key: 'gg' }
    if (matchesKey(data, 'end') || printable === 'G') return { type: 'key', key: 'G' }

    switch (printable) {
      case '/':
        return { type: 'filter' }
      case '.':
        return { type: 'toggleShowAll' }
      case 'n':
        return { type: 'searchNext' }
      case 'N':
        return { type: 'searchPrev' }
      case ':':
        return { type: 'command' }
      case '!':
        this.openActionDetailOverlay()
        return undefined
      case 'o':
      case 'a':
      case 'r':
      case 'R':
      case 'e':
      case 'c':
      case 'i':
        return { type: 'action', key: printable }
      case 'g':
        this.keyPrefix = 'g'
        return undefined
      case 'm':
        this.keyPrefix = 'mark'
        return undefined
      case "'":
        this.keyPrefix = 'jump'
        return undefined
      case '?':
        return { type: 'help' }
      case 'q':
        return { type: 'quit' }
      case 'h':
      case 'l':
        return { type: 'noop', reason: 'pane/group movement is not active yet' }
      default:
        return { type: 'noop', reason: 'unmapped key' }
    }
  }

  private handleIntent(intent: HrcTopKeyIntent): void {
    this.notice = undefined

    if (intent.type === 'quit') {
      if (this.eventTailPreview) {
        this.eventTailPreview = undefined
        this.requestRender()
        return
      }
      if (this.inspectMode) {
        this.inspectMode = false
        this.requestRender()
        return
      }
      if (this.focusMode) {
        this.focusMode = false
        this.requestRender()
        return
      }
      this.onQuit()
      return
    }

    if (intent.type === 'focus') {
      this.focusMode = true
      this.inspectMode = false
      this.eventTailPreview = undefined
      this.requestRender()
      return
    }

    if (intent.type === 'help') {
      this.showHelp = true
      this.keyPrefix = undefined
      this.requestRender()
      return
    }

    if (intent.type === 'noop') {
      this.notice = intent.reason
      this.clearActionDetailOverlay()
      this.requestRender()
      return
    }

    if (intent.type === 'filter') {
      this.commandMode = false
      this.filterInput.setValue(this.filterText)
      this.filterMode = true
      this.requestRender()
      return
    }

    if (intent.type === 'toggleShowAll') {
      this.showAll = !this.showAll
      this.recomputeNav()
      this.requestRender()
      return
    }

    if (intent.type === 'command') {
      this.filterMode = false
      this.commandInput.setValue('')
      this.commandMode = true
      this.requestRender()
      return
    }

    if (intent.type === 'action') {
      this.enqueue(() => this.handleActionKey(intent.key))
      return
    }

    if (intent.type === 'searchNext' || intent.type === 'searchPrev') {
      const filtered = this.visibleRows()
      const bodyHeight = Math.max(1, this.height() - 8)
      if (this.filterText.trim().length === 0 || filtered.length <= bodyHeight) {
        this.notice = 'n/N search only moves when a filter narrows past the viewport'
        this.requestRender()
        return
      }
      this.navState = reduceNavState(
        this.navState,
        { type: 'key', key: intent.type === 'searchNext' ? 'j' : 'k' },
        { visibleRows: filtered, viewportHeight: this.height() }
      )
      this.requestRender()
      return
    }

    this.navState = reduceNavState(this.navState, intent, {
      visibleRows: this.visibleRows(),
      viewportHeight: this.height(),
    })
    this.requestRender()
  }

  private async handleActionKey(key: string): Promise<void> {
    try {
      const row = this.selectedRow()
      if (!row) {
        this.notice = 'No target selected.'
        this.clearActionDetailOverlay()
        this.requestRender()
        return
      }
      if (this.openAmbiguityResolverForKey(key, row)) {
        this.requestRender()
        return
      }
      this.clearActionDetailOverlay()
      const result = await dispatchHrcTopActionKey({
        key,
        row,
        executor: this.executor,
      })
      await this.handleActionResult(result, row.id, row)
    } catch (error) {
      const row = this.selectedRow()
      const message = error instanceof Error ? error.message : String(error)
      this.notice = `${message}; press ! for details`
      this.actionDetailOverlay = {
        action: actionForInputKey(key),
        status: 'disabled',
        reason: message,
        detail: {
          action: actionForInputKey(key),
          status: 'disabled',
          message,
          targetIdentity: row ? targetIdentityForRow(row) : undefined,
        },
        open: false,
      }
      this.requestRender()
    }
  }

  private openAmbiguityResolverForKey(key: string, row: HrcTopRow): boolean {
    if (key === 'a') return this.openAmbiguityResolver('attach', row)
    if (key === 'i') return this.openAmbiguityResolver('inspect', row)
    if (key === 'o') return this.openAmbiguityResolver('attach', row)
    return false
  }

  private openAmbiguityResolver(action: HrcTopAmbiguityAction, row: HrcTopRow): boolean {
    const model = buildHrcTopAmbiguityModel(this.model.rows)
    const group = ambiguityGroupForRow(model, row)
    const candidates = candidatesForAmbiguousAction(group, action)
    if (!group?.ambiguous || candidates.length <= 1) return false

    this.ambiguityResolver = {
      originRowId: row.id,
      handle: handleForRow(row),
      action,
      candidates,
      selectedIndex: firstEnabledCandidateIndex(action, candidates),
    }
    this.focusMode = false
    this.inspectMode = false
    this.inspectCandidateRow = undefined
    this.eventTailPreview = undefined
    this.runConfirmationOverlay = undefined
    this.showHelp = false
    this.keyPrefix = undefined
    this.notice = undefined
    return true
  }

  private async submitCommand(value: string): Promise<void> {
    const row = this.selectedRow()
    if (!row) {
      this.notice = 'No target selected.'
      this.requestRender()
      return
    }

    try {
      const commandAction = ambiguityActionForCommand(value)
      if (commandAction && this.openAmbiguityResolver(commandAction, row)) {
        this.requestRender()
        return
      }
      this.clearActionDetailOverlay()
      await this.handleActionResult(
        await executeHrcTopCommandLine({
          line: `:${value}`,
          row,
          executor: this.executor,
        }),
        row.id,
        row
      )
    } catch (error) {
      const action = actionForCommandValue(value)
      const message = error instanceof Error ? error.message : String(error)
      this.notice = `${message}; press ! for details`
      this.actionDetailOverlay = {
        action,
        status: 'disabled',
        reason: message,
        detail: {
          action,
          status: 'disabled',
          message,
          targetIdentity: targetIdentityForRow(row),
        },
        open: false,
      }
      this.requestRender()
    }
  }

  private async handleActionResult(
    result: HrcTopActionResult,
    selectedRowId?: string | undefined,
    selectedRow?: HrcTopRow | undefined
  ): Promise<void> {
    const detail = actionDetailForResult(result, selectedRow ?? this.rowById(selectedRowId))
    this.actionDetailOverlay = detail
      ? {
          action: result.action,
          status: result.status,
          reason: result.reason,
          errorCode: result.errorCode,
          detail,
          open: false,
        }
      : undefined
    this.notice = detail && result.reason ? `${result.reason}; press ! for details` : result.reason
    if (result.action !== 'inspect') this.inspectCandidateRow = undefined
    if (result.status === 'confirmation_required') {
      const row = selectedRow ?? this.rowById(selectedRowId)
      if (!row) {
        this.runConfirmationOverlay = undefined
        this.notice = 'Run confirmation expired; select the target and press R again.'
        this.requestRender()
        return
      }
      this.runConfirmationOverlay = {
        rowId: row.id,
        handle: handleForRow(row),
        continuationText: continuationTextForRow(row),
      }
      this.showHelp = false
      this.keyPrefix = undefined
      this.requestRender()
      return
    }

    this.runConfirmationOverlay = undefined
    if (result.status === 'quit') {
      this.onQuit()
      return
    }
    if (result.status === 'filter_changed') {
      this.filterText = result.filterText ?? ''
      this.filterInput.setValue(this.filterText)
      this.recomputeNav()
    }
    if (result.action === 'tail') {
      this.focusMode = false
      this.inspectMode = false
      await this.openEventTailPreview(selectedRow ?? this.rowById(selectedRowId))
      return
    }
    if (result.action === 'focus') {
      this.focusMode = true
      this.inspectMode = false
      this.eventTailPreview = undefined
    }
    if (result.action === 'inspect') {
      this.inspectMode = true
      this.focusMode = false
      this.eventTailPreview = undefined
    }
    if (result.status === 'executed') {
      await this.refresh()
      return
    }
    this.requestRender()
  }

  private enqueue(action: () => Promise<void>): void {
    const next = this.pendingAction.then(action, action)
    this.pendingAction = next.catch(() => undefined)
    void this.pendingAction
  }

  private rowById(rowId: string | undefined): HrcTopRow | undefined {
    if (!rowId) return undefined
    return this.model.rows.find((row) => row.id === rowId)
  }

  private handleAmbiguityResolverInput(data: string): void {
    const overlay = this.ambiguityResolver
    if (!overlay) return
    const printable = printableInput(data)

    if (printable === 'q' || data === '\x1b' || matchesKey(data, 'escape')) {
      this.ambiguityResolver = undefined
      this.keyPrefix = undefined
      this.notice = 'Ambiguity resolver cancelled.'
      this.requestRender()
      return
    }

    if (matchesKey(data, 'down') || printable === 'j') {
      this.ambiguityResolver = {
        ...overlay,
        selectedIndex: Math.min(overlay.candidates.length - 1, overlay.selectedIndex + 1),
      }
      this.requestRender()
      return
    }

    if (matchesKey(data, 'up') || printable === 'k') {
      this.ambiguityResolver = {
        ...overlay,
        selectedIndex: Math.max(0, overlay.selectedIndex - 1),
      }
      this.requestRender()
      return
    }

    if (matchesKey(data, 'enter') || matchesKey(data, 'return')) {
      this.enqueue(() => this.confirmAmbiguityResolver())
      return
    }

    this.notice = 'Ambiguity resolver is active; choose with j/k, Enter confirms, Esc or q cancels.'
    this.requestRender()
  }

  private async confirmAmbiguityResolver(): Promise<void> {
    const overlay = this.ambiguityResolver
    if (!overlay) return

    const selected = overlay.candidates[overlay.selectedIndex]
    if (!selected) {
      this.expireAmbiguityResolver('Ambiguity resolver expired; choose the action again.')
      return
    }

    const revalidated = this.revalidatedAmbiguityCandidate(overlay, selected.source)
    if (!revalidated) {
      this.expireAmbiguityResolver('Selected ambiguity candidate changed; no action was executed.')
      return
    }

    if (overlay.action === 'attach') {
      await this.confirmAttachCandidate(revalidated)
      return
    }

    this.ambiguityResolver = undefined
    this.inspectCandidateRow = revalidated.row
    this.inspectMode = true
    this.focusMode = false
    this.eventTailPreview = undefined
    this.navState = createNavState({
      visibleRows: [...this.visibleRows(), { id: revalidated.row.id }],
      viewportHeight: this.height(),
      selectedRowId: revalidated.row.id,
    })
    this.notice = `Inspecting runtime ${revalidated.runtimeId ?? revalidated.source.activeHostSessionId}.`
    this.requestRender()
  }

  private async confirmAttachCandidate(candidate: HrcTopAmbiguityCandidate): Promise<void> {
    if (!candidate.runtimeId || !candidate.attachable) {
      this.notice = candidate.disabledReason ?? 'Selected candidate is not attachable.'
      this.actionDetailOverlay = {
        action: 'attach',
        status: 'disabled',
        reason: this.notice,
        detail: {
          action: 'attach',
          status: 'disabled',
          message: this.notice,
          targetIdentity: targetIdentityForRow(candidate.row),
        },
        open: false,
      }
      this.requestRender()
      return
    }

    this.ambiguityResolver = undefined
    try {
      this.clearActionDetailOverlay()
      const descriptor = await this.executor.attachRuntime(candidate.runtimeId)
      const spawned = await this.executor.spawnAttachDescriptor(descriptor)
      await this.handleActionResult(
        {
          status: spawned.status ?? 'executed',
          action: 'attach',
          reason: spawned.reason ?? `Attached to runtime ${candidate.runtimeId}.`,
          errorCode: spawned.errorCode,
          detail: spawned.detail,
        },
        candidate.row.id,
        candidate.row
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.notice = `${message}; press ! for details`
      this.actionDetailOverlay = {
        action: 'attach',
        status: 'disabled',
        reason: message,
        detail: {
          action: 'attach',
          status: 'disabled',
          message,
          targetIdentity: targetIdentityForRow(candidate.row),
        },
        open: false,
      }
      this.requestRender()
    }
  }

  private revalidatedAmbiguityCandidate(
    overlay: AmbiguityResolverOverlayState,
    source: HrcTopAmbiguitySourceIdentity
  ): HrcTopAmbiguityCandidate | undefined {
    const model = buildHrcTopAmbiguityModel(this.model.rows)
    const group = model.byHandle.get(overlay.handle)
    const candidates = candidatesForAmbiguousAction(group, overlay.action)
    return candidates.find((candidate) => sameAmbiguitySource(candidate.source, source))
  }

  private handleRunConfirmationInput(data: string): void {
    const printable = printableInput(data)
    if (printable === 'R' || matchesKey(data, 'enter') || matchesKey(data, 'return')) {
      this.enqueue(() => this.confirmRunOverlay())
      return
    }
    if (printable === 'q' || data === '\x1b' || matchesKey(data, 'escape')) {
      this.runConfirmationOverlay = undefined
      this.keyPrefix = undefined
      this.requestRender()
      return
    }
    this.notice = 'Run confirmation is active; press R or Enter to confirm, Esc or q to cancel.'
    this.requestRender()
  }

  private async confirmRunOverlay(): Promise<void> {
    const overlay = this.runConfirmationOverlay
    if (!overlay) return

    const selected = this.selectedRow()
    const rowById = this.rowById(overlay.rowId)
    const selectedHandle = selected ? handleForRow(selected) : undefined
    const rowByIdHandle = rowById ? handleForRow(rowById) : undefined
    if (
      !selected ||
      !rowById ||
      selected.id !== overlay.rowId ||
      selected.id !== rowById.id ||
      selectedHandle !== overlay.handle ||
      rowByIdHandle !== overlay.handle
    ) {
      this.expireRunConfirmation()
      return
    }

    try {
      this.runConfirmationOverlay = undefined
      this.clearActionDetailOverlay()
      const result = await dispatchHrcTopActionKey({
        key: 'R',
        row: selected,
        executor: this.executor,
        confirmRunWithContinuation: true,
      })
      await this.handleActionResult(result, selected.id, selected)
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error)
      this.requestRender()
    }
  }

  private expireRunConfirmationIfStale(): void {
    const overlay = this.runConfirmationOverlay
    if (!overlay) return
    const selected = this.selectedRow()
    const rowById = this.rowById(overlay.rowId)
    if (
      !selected ||
      !rowById ||
      selected.id !== overlay.rowId ||
      selected.id !== rowById.id ||
      handleForRow(selected) !== overlay.handle ||
      handleForRow(rowById) !== overlay.handle
    ) {
      this.expireRunConfirmation()
    }
  }

  private expireRunConfirmation(): void {
    this.runConfirmationOverlay = undefined
    this.keyPrefix = undefined
    this.notice = 'Run confirmation expired; select the target and press R again.'
    this.requestRender()
  }

  private expireAmbiguityResolver(reason: string): void {
    if (!this.ambiguityResolver) return
    this.ambiguityResolver = undefined
    this.keyPrefix = undefined
    this.notice = reason
  }

  private openActionDetailOverlay(): void {
    if (!this.actionDetailOverlay) {
      this.notice = 'No action detail is available.'
      this.requestRender()
      return
    }
    this.actionDetailOverlay = { ...this.actionDetailOverlay, open: true }
    this.keyPrefix = undefined
    this.showHelp = false
    this.requestRender()
  }

  private handleActionDetailOverlayInput(data: string): void {
    const printable = printableInput(data)
    if (printable === 'q' || data === '\x1b' || matchesKey(data, 'escape')) {
      if (this.actionDetailOverlay) {
        this.actionDetailOverlay = { ...this.actionDetailOverlay, open: false }
      }
      this.keyPrefix = undefined
      this.requestRender()
      return
    }
    this.notice = 'Action detail is open; press Esc or q to return.'
    this.requestRender()
  }

  private clearActionDetailOverlay(): void {
    this.actionDetailOverlay = undefined
  }

  private expireActionDetailIfStale(): void {
    const identity = this.actionDetailOverlay?.detail.targetIdentity
    if (!identity) return
    const row = this.selectedRow()
    if (!row || targetIdentityKey(targetIdentityForRow(row)) !== targetIdentityKey(identity)) {
      this.actionDetailOverlay = undefined
    }
  }

  private async openEventTailPreview(row: HrcTopRow | undefined): Promise<void> {
    if (!row) {
      this.notice = 'No target selected.'
      this.requestRender()
      return
    }

    const previewBase = {
      rowId: row.id,
      handle: handleForRow(row),
      events: [],
    }

    if (typeof this.client.watch !== 'function') {
      this.eventTailPreview = {
        ...previewBase,
        error: 'Event tail is unavailable: this HRC client does not expose monitor events.',
      }
      this.notice = undefined
      this.requestRender()
      return
    }

    try {
      const events: HrcLifecycleEvent[] = []
      for await (const event of this.client.watch(tailWatchOptions(row))) {
        events.push(event)
        if (events.length > 50) events.shift()
      }
      this.eventTailPreview = {
        ...previewBase,
        events,
      }
      this.notice = undefined
    } catch (error) {
      this.eventTailPreview = {
        ...previewBase,
        error: error instanceof Error ? error.message : String(error),
      }
      this.notice = undefined
    }
    this.requestRender()
  }
}

function tailWatchOptions(row: HrcTopRow): WatchOptions {
  const target = row.target
  return {
    follow: false,
    hostSessionId: target.activeHostSessionId,
    generation: target.generation,
    scopeRef: target.scopeRef,
    laneRef: target.laneRef,
  }
}

function renderEventTailPreview(input: {
  preview: EventTailPreviewState
  height: number
  width: number
}): string[] {
  const { preview, width } = input
  const header = [`EVENT TAIL  ${preview.handle}`, '']
  const footer = ['', '-'.repeat(width), 'q return']
  const bodyHeight = Math.max(1, input.height - header.length - footer.length)
  const body = eventTailBody(preview, bodyHeight)
  return [...header, ...body, ...footer].map((line) => truncateToWidth(line, width, '', false))
}

function eventTailBody(preview: EventTailPreviewState, height: number): string[] {
  if (preview.error) {
    return [`Event tail unavailable: ${preview.error}`]
  }
  if (preview.events.length === 0) {
    return [`No recent events for ${preview.handle}.`]
  }
  return preview.events.slice(-height).map(renderEventLine)
}

function renderEventLine(event: HrcLifecycleEvent): string {
  const ts = event.ts.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
  const seq = `#${event.hrcSeq}`
  const bits = [seq, ts, event.category, event.eventKind]
  if (event.runId) bits.push(`run=${event.runId}`)
  if (event.runtimeId) bits.push(`runtime=${event.runtimeId}`)
  const payload = payloadPreview(event.payload)
  return payload ? `${bits.join('  ')}  ${payload}` : bits.join('  ')
}

function payloadPreview(payload: unknown): string {
  if (payload === undefined || payload === null) return ''
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload)
  } catch {
    return String(payload)
  }
}

function renderHelpOverlay(baseLines: string[], height: number, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const lines = baseLines.slice(0, height)
  while (lines.length < height) lines.push('')

  const overlayWidth = Math.max(1, Math.min(safeWidth, 84))
  const bodyWidth = Math.max(1, overlayWidth - 4)
  const content = helpOverlayContent().slice(0, Math.max(1, height - 2))
  const border = `+${'-'.repeat(Math.max(0, overlayWidth - 2))}+`
  const overlay = [
    border,
    ...content.map((line) => framedHelpLine(line, bodyWidth, overlayWidth)),
    border,
  ]
  const top = Math.max(0, Math.floor((height - overlay.length) / 2))
  const left = Math.max(0, Math.floor((safeWidth - overlayWidth) / 2))

  for (let index = 0; index < overlay.length && top + index < lines.length; index += 1) {
    lines[top + index] = truncateToWidth(
      `${' '.repeat(left)}${overlay[index]}`,
      safeWidth,
      '',
      false
    )
  }

  return lines.map((line) => truncateToWidth(line, safeWidth, '', false))
}

function renderRunConfirmationOverlay(
  baseLines: string[],
  overlayState: RunConfirmationOverlayState,
  height: number,
  width: number
): string[] {
  const content = [
    'RUN CONFIRMATION',
    `Target: ${overlayState.handle}`,
    overlayState.continuationText
      ? `Continuation: ${overlayState.continuationText}`
      : 'Continuation: captured',
    'hrc run starts a fresh run and bypasses resume semantics for this target.',
    'A continuation exists; use resume if you want to continue that conversation.',
    'Confirm: R or Enter',
    'Cancel: Esc or q',
  ]
  return renderFramedOverlay(baseLines, content, height, width)
}

function renderAmbiguityResolverOverlay(
  baseLines: string[],
  overlayState: AmbiguityResolverOverlayState,
  height: number,
  width: number
): string[] {
  const action = overlayState.action === 'attach' ? 'ATTACH RESOLVER' : 'INSPECT RESOLVER'
  const content = [
    action,
    `Target: ${overlayState.handle}`,
    'Choose a concrete runtime candidate:',
    ...overlayState.candidates.map((candidate, index) => {
      const marker = index === overlayState.selectedIndex ? '>' : ' '
      const runtime = candidate.runtimeId ?? candidate.source.activeHostSessionId ?? 'no-runtime'
      const disabled =
        overlayState.action === 'attach' && !candidate.attachable
          ? ` disabled: ${candidate.disabledReason ?? 'not attachable'}`
          : ''
      return `${marker} ${runtime}  ${candidate.label}${disabled}`
    }),
    'Confirm: Enter',
    'Cancel: Esc or q',
  ]
  return renderFramedOverlay(baseLines, content, height, width)
}

function renderActionDetailOverlay(
  baseLines: string[],
  overlayState: ActionDetailOverlayState,
  height: number,
  width: number
): string[] {
  const detail = overlayState.detail
  const content = [
    'ACTION DETAIL',
    detailLine('action', detail.action ?? overlayState.action),
    detailLine('status', detail.status ?? overlayState.status),
    detailLine('message', detail.message ?? overlayState.reason),
    detailLine('error code', detail.errorCode ?? overlayState.errorCode),
    ...targetIdentityLines(detail.targetIdentity),
    ...commandDetailLines(detail),
    'Dismiss: Esc or q',
  ].filter((line): line is string => line !== undefined)
  return renderFramedOverlay(baseLines, content, height, width, 120)
}

function targetIdentityLines(identity: HrcTopActionTargetIdentity | undefined): string[] {
  if (!identity) return []
  const runtimeBits = [
    detailLine('laneRef', identity.laneRef),
    detailLine('hostSessionId', identity.hostSessionId),
    detailLine('generation', identity.generation),
    detailLine('runtimeId', identity.runtimeId),
  ]
    .filter((line): line is string => line !== undefined)
    .join('  ')
  return [
    detailLine('target', identity.handle),
    detailLine('sessionRef', identity.sessionRef),
    detailLine('scopeRef', identity.scopeRef),
    runtimeBits,
  ].filter((line): line is string => line !== undefined && line !== '')
}

function commandDetailLines(detail: HrcTopActionDetail): string[] {
  const lines: string[] = []
  if (detail.argv && detail.argv.length > 0) {
    lines.push('command:', `argv: ${detail.argv.join(' ')}`)
  }
  if (detail.exitStatus !== undefined) lines.push(`exit status: ${detail.exitStatus}`)
  if (detail.stderrSummary) lines.push('stderr:', detail.stderrSummary)
  return lines
}

function detailLine(label: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return `${label}: ${String(value)}`
}

function renderFramedOverlay(
  baseLines: string[],
  content: string[],
  height: number,
  width: number,
  maxWidth = 84
): string[] {
  const safeWidth = Math.max(1, width)
  const lines = baseLines.slice(0, height)
  while (lines.length < height) lines.push('')

  const overlayWidth = Math.max(1, Math.min(safeWidth, maxWidth))
  const bodyWidth = Math.max(1, overlayWidth - 4)
  const overlayContent = content.slice(0, Math.max(1, height - 2))
  const border = `+${'-'.repeat(Math.max(0, overlayWidth - 2))}+`
  const overlay = [
    border,
    ...overlayContent.map((line) => framedHelpLine(line, bodyWidth, overlayWidth)),
    border,
  ]
  const top = Math.max(0, Math.floor((height - overlay.length) / 2))
  const left = Math.max(0, Math.floor((safeWidth - overlayWidth) / 2))

  for (let index = 0; index < overlay.length && top + index < lines.length; index += 1) {
    lines[top + index] = truncateToWidth(
      `${' '.repeat(left)}${overlay[index]}`,
      safeWidth,
      '',
      false
    )
  }

  return lines.map((line) => truncateToWidth(line, safeWidth, '', false))
}

function helpOverlayContent(): string[] {
  return [
    'HELP',
    'NORMAL MODE',
    'j/k or arrows move | gg/G top/bottom | Ctrl-d/u half-page | Ctrl-f/b page',
    "m<char> mark | '<char> jump | / filter | n/N next/prev | . show all",
    'Enter focus | o recommended action | q quit',
    'FILTER MODE',
    'Type to filter rows | Enter accept | Esc accept current text | Backspace edits',
    'COMMAND MODE',
    ':filter <text> | :clear-filter | :quit',
    ':attach | :resume | :run | :tail | :capture | :inspect',
    'Destructive verbs are disabled; actions use the same availability checks as keys.',
    'ACTIONS',
    'a attach | r resume | R run | e tail | c capture | i inspect',
    'o runs the selected row recommendation; Enter/i/e are read-only views',
    '?/Esc/q close help; other keys stay in this overlay',
  ]
}

function framedHelpLine(line: string, bodyWidth: number, overlayWidth: number): string {
  const body = truncateToWidth(line, bodyWidth, '', false)
  return `| ${body}${' '.repeat(Math.max(0, overlayWidth - body.length - 4))} |`
}

function isHelpDismissInput(data: string): boolean {
  const printable = printableInput(data)
  return printable === '?' || printable === 'q' || data === '\x1b' || matchesKey(data, 'escape')
}

function continuationTextForRow(row: HrcTopRow): string | undefined {
  const continuation = row.target.continuation
  if (!continuation) return undefined
  return continuation.key ? `${continuation.provider}:${continuation.key}` : continuation.provider
}

function firstEnabledCandidateIndex(
  action: HrcTopAmbiguityAction,
  candidates: readonly HrcTopAmbiguityCandidate[]
): number {
  if (action !== 'attach') return 0
  const index = candidates.findIndex((candidate) => candidate.attachable)
  return index >= 0 ? index : 0
}

function ambiguityActionForCommand(value: string): HrcTopAmbiguityAction | undefined {
  const verb = value.trim().split(/\s+/)[0]
  if (verb === 'attach') return 'attach'
  if (verb === 'inspect') return 'inspect'
  return undefined
}

function actionForCommandValue(value: string): HrcTopExplicitAction | undefined {
  const verb = value.trim().split(/\s+/)[0]
  switch (verb) {
    case 'attach':
    case 'resume':
    case 'run':
    case 'tail':
    case 'capture':
    case 'inspect':
      return verb
    default:
      return undefined
  }
}

function actionForInputKey(key: string): HrcTopExplicitAction | undefined {
  switch (key) {
    case 'a':
      return 'attach'
    case 'r':
      return 'resume'
    case 'R':
      return 'run'
    case 'c':
      return 'capture'
    case 'e':
      return 'tail'
    case 'i':
      return 'inspect'
    case 'o':
      return 'unavailable'
    default:
      return undefined
  }
}

function actionDetailForResult(
  result: HrcTopActionResult,
  row: HrcTopRow | undefined
): HrcTopActionDetail | undefined {
  if (result.detail) {
    return {
      ...result.detail,
      action: result.detail.action ?? result.action,
      status: result.detail.status ?? result.status,
      message: result.detail.message ?? result.reason,
      errorCode: result.detail.errorCode ?? result.errorCode,
      targetIdentity: result.detail.targetIdentity ?? (row ? targetIdentityForRow(row) : undefined),
    }
  }
  if (
    result.status !== 'disabled' ||
    !row ||
    !result.action ||
    !actionSupportsTransientDetail(result.action)
  ) {
    return undefined
  }
  return {
    action: result.action,
    status: result.status,
    message: result.reason,
    errorCode: result.errorCode,
    targetIdentity: targetIdentityForRow(row),
  }
}

function actionSupportsTransientDetail(action: HrcTopExplicitAction): boolean {
  return action === 'attach' || action === 'resume' || action === 'run' || action === 'capture'
}

function targetIdentityForRow(row: HrcTopRow): HrcTopActionTargetIdentity {
  return {
    handle: handleForRow(row),
    sessionRef: row.sessionRef,
    scopeRef: row.target.scopeRef,
    laneRef: row.target.laneRef,
    hostSessionId: row.target.activeHostSessionId,
    generation: row.target.generation,
    runtimeId: row.target.runtime?.runtimeId ?? row.runtime?.runtimeId,
  }
}

function targetIdentityKey(identity: HrcTopActionTargetIdentity): string {
  return [
    identity.handle,
    identity.sessionRef,
    identity.scopeRef ?? '',
    identity.laneRef ?? '',
    identity.hostSessionId ?? '',
    identity.generation ?? '',
    identity.runtimeId ?? '',
  ].join('\0')
}

function isHrcPiTopRestoreTerminalReport(data: string): boolean {
  if (data.length === 0) return false

  const esc = '\u001b'
  if (!data.startsWith(esc)) {
    const paste = bracketedPasteContent(data)
    return paste !== undefined && printableInput(paste) === undefined
  }

  const tail = data.slice(esc.length)
  if (/^\[(?:\?[\d;]*|>[\d;]*|[\d;]*)c$/.test(tail)) return true
  if (/^\[\d+;\d+R$/.test(tail)) return true
  if (/^\[[IO]$/.test(tail)) return true
  if (tail.startsWith('O') && tail.length === 2) return true
  if (tail.startsWith(']') && (data.endsWith('\u0007') || data.endsWith(`${esc}\\`))) {
    return true
  }
  if (/^\[(?:\d+;)*\d*t$/.test(tail)) return true
  if (tail.startsWith('[M') && tail.length === 5) return true

  const paste = bracketedPasteContent(data)
  if (paste !== undefined) return printableInput(paste) === undefined

  return false
}

function printableInput(data: string): string | undefined {
  const pasted = singleCharacterPaste(data)
  if (pasted !== undefined) return printableInput(pasted)
  const kittyPrintable = decodeKittyPrintable(data)
  if (kittyPrintable !== undefined) return kittyPrintable
  if (data.length !== 1) return undefined
  const code = data.charCodeAt(0)
  if (code < 32 || code === 127) return undefined
  return data
}

function singleCharacterPaste(data: string): string | undefined {
  const pasted = bracketedPasteContent(data)
  if (pasted === undefined) return undefined
  return [...pasted].length === 1 ? pasted : undefined
}

function bracketedPasteContent(data: string): string | undefined {
  const open = '\x1b[200~'
  const close = '\x1b[201~'
  if (!data.startsWith(open) || !data.endsWith(close)) return undefined
  return data.slice(open.length, data.length - close.length)
}

function splitFrame(frame: string): string[] {
  const trimmed = frame.endsWith('\n') ? frame.slice(0, -1) : frame
  if (trimmed.length === 0) return []
  return trimmed.split('\n')
}

function replaceLine(
  lines: string[],
  predicate: (line: string) => boolean,
  replacement: string
): void {
  const index = lines.findIndex(predicate)
  if (index >= 0) {
    lines[index] = replacement
    return
  }
  lines.push(replacement)
}

function isInteractiveProcess(options: HrcPiTopOptions): boolean {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  return (
    input.isTTY === true &&
    (output as NodeJS.WriteStream).isTTY === true &&
    typeof input.setRawMode === 'function'
  )
}

function requireActionClient(client: HrcPiTopClient): Pick<HrcClient, 'attachRuntime'> {
  if (typeof client.attachRuntime !== 'function') {
    throw new Error('hrc-pi-top action execution requires an HrcClient with attachRuntime')
  }
  return { attachRuntime: client.attachRuntime.bind(client) }
}
