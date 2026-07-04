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
  type HrcTopActionExecutor,
  type HrcTopActionResult,
  type HrcTopKeyIntent,
  type HrcTopKeyPrefix,
  type HrcTopNavState,
  type HrcTopOptions,
  type HrcTopReadModel,
  type HrcTopRow,
  type HrcTopScope,
  createHrcTopActionExecutor,
  createNavState,
  dispatchHrcTopActionKey,
  executeHrcTopCommandLine,
  loadReadModel,
  reduceNavState,
  renderTopScreen,
  runHrcTop,
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
  let suspendedForSpawn = false
  let resolveClosed: (() => void) | undefined
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const stop = () => {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    timer = undefined
    if (started) {
      started = false
      tui.stop()
    }
    resolveClosed?.()
  }

  const executor = createHrcTopActionExecutor(requireActionClient(client), {
    beforeSpawn: () => {
      suspendedForSpawn = true
      if (started) {
        started = false
        tui.stop()
      }
    },
    afterSpawn: () => {
      if (closed) return
      suspendedForSpawn = false
      tui.start()
      started = true
      app.invalidate()
      tui.requestRender(true)
    },
  })

  const app = new HrcPiTopApp({
    client,
    executor,
    initialModel: model,
    scope: options,
    viewportHeight: () => terminal.rows,
    requestRender: () => tui.requestRender(),
    onQuit: stop,
    isSuspended: () => suspendedForSpawn,
  })

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
  private showAll = false
  private showHelp = false
  private filterText = ''
  private filterMode = false
  private commandMode = false
  private notice: string | undefined
  private eventTailPreview: EventTailPreviewState | undefined
  private pendingRunConfirmationRowId: string | undefined
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
    selectedRowId: string | undefined
    notice: string | undefined
  } {
    return {
      filterText: this.filterText,
      filterMode: this.filterMode,
      commandMode: this.commandMode,
      focusMode: this.focusMode,
      selectedRowId: this.navState.selectedRowId,
      notice: this.notice,
    }
  }

  async whenIdle(): Promise<void> {
    await this.pendingAction
  }

  render(width: number): string[] {
    if (this.eventTailPreview) {
      return renderEventTailPreview({
        preview: this.eventTailPreview,
        height: this.height(),
        width,
      })
    }

    const frame = renderTopScreen({
      model: this.model,
      navState: this.navState,
      viewportHeight: this.height(),
      width,
      filterText: this.filterText,
      filterMode: this.filterMode,
      commandText: this.commandInput.getValue(),
      commandMode: this.commandMode,
      focusMode: this.focusMode,
      showAll: this.showAll,
      showHelp: this.showHelp,
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

    return lines.map((line) => truncateToWidth(line, width, '', false))
  }

  handleInput(data: string): void {
    if (this.isSuspended()) return
    this.notice = undefined

    if (matchesKey(data, 'ctrl+c')) {
      this.onQuit()
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
      this.requestRender()
      return
    }

    if (intent.type === 'help') {
      this.showHelp = !this.showHelp
      this.requestRender()
      return
    }

    if (intent.type === 'noop') {
      this.notice = intent.reason
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
        this.requestRender()
        return
      }
      const confirmRunWithContinuation = key === 'R' && this.pendingRunConfirmationRowId === row.id
      const result = await dispatchHrcTopActionKey({
        key,
        row,
        executor: this.executor,
        confirmRunWithContinuation,
      })
      await this.handleActionResult(result, row.id, row)
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error)
      this.requestRender()
    }
  }

  private async submitCommand(value: string): Promise<void> {
    const row = this.selectedRow()
    if (!row) {
      this.notice = 'No target selected.'
      this.requestRender()
      return
    }

    try {
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
      this.notice = error instanceof Error ? error.message : String(error)
      this.requestRender()
    }
  }

  private async handleActionResult(
    result: HrcTopActionResult,
    selectedRowId?: string | undefined,
    selectedRow?: HrcTopRow | undefined
  ): Promise<void> {
    this.notice = result.reason
    if (result.status === 'confirmation_required') {
      this.pendingRunConfirmationRowId = selectedRowId
      this.requestRender()
      return
    }

    this.pendingRunConfirmationRowId = undefined
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
      await this.openEventTailPreview(selectedRow ?? this.rowById(selectedRowId))
      return
    }
    if (result.action === 'focus' || result.action === 'inspect') {
      this.focusMode = true
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

function handleForRow(row: HrcTopRow): string {
  return handleFromScopeRef(row.target.scopeRef) ?? row.sessionRef
}

function handleFromScopeRef(scopeRef: string): string | undefined {
  const agent = scopeRef.match(/^agent:([^:]+)/)?.[1]
  const project = scopeRef.match(/:project:([^:]+)/)?.[1]
  const task = scopeRef.match(/:task:([^:/]+)/)?.[1]
  if (!agent || !project) return undefined
  return task ? `${agent}@${project}:${task}` : `${agent}@${project}`
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
  const open = '\x1b[200~'
  const close = '\x1b[201~'
  if (!data.startsWith(open) || !data.endsWith(close)) return undefined
  const pasted = data.slice(open.length, data.length - close.length)
  return [...pasted].length === 1 ? pasted : undefined
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
