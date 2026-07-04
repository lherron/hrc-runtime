import { HrcClient, discoverSocket } from 'hrc-sdk'
import {
  type HrcTopActionResult,
  dispatchHrcTopActionKey,
  executeHrcTopCommandLine,
} from './commands.js'
import { createHrcTopActionExecutor } from './executor.js'
import { interpretHrcTopKey } from './keymap.js'
import type { HrcTopKeyIntent, HrcTopKeyPrefix } from './keymap.js'
import { createNavState, reduceNavState } from './nav-state.js'
import type { HrcTopNavState } from './nav-state.js'
import { buildReadModel, loadReadModel } from './read-model.js'
import type { HrcTopReadModel, HrcTopRow, HrcTopScope } from './read-model.js'
import { renderTopScreen, selectVisibleTriageRowIds } from './render.js'

type HrcTopClient = Pick<HrcClient, 'listTargets'> & Partial<Pick<HrcClient, 'attachRuntime'>>
type HrcTopTerminalInputState = 'normal' | 'escape' | 'csi' | 'ss3' | 'osc' | 'oscEscape'
type HrcTopTerminalInput = Pick<NodeJS.ReadStream, 'read' | 'resume'> & {
  setRawMode?: ((mode: boolean) => NodeJS.ReadStream) | undefined
}
type HrcTopTerminalOutput = Pick<NodeJS.WritableStream, 'write'>

export type HrcTopOptions = HrcTopScope & {
  client?: HrcTopClient | undefined
  socketPath?: string | undefined
  output?: NodeJS.WritableStream | undefined
  input?: NodeJS.ReadStream | undefined
  pollIntervalMs?: number | undefined
}

export { buildReadModel, loadReadModel }
export {
  actionNeedsAmbiguityResolution,
  ambiguityGroupForRow,
  buildHrcTopAmbiguityModel,
  candidatesForAmbiguousAction,
  sameAmbiguitySource,
} from './ambiguity.js'
export type {
  HrcTopAmbiguityAction,
  HrcTopAmbiguityCandidate,
  HrcTopAmbiguityGroup,
  HrcTopAmbiguityModel,
  HrcTopAmbiguitySourceIdentity,
} from './ambiguity.js'
export { dispatchHrcTopActionKey, executeHrcTopCommandLine, handleForRow } from './commands.js'
export type { HrcTopActionExecutor, HrcTopActionResult } from './commands.js'
export { createHrcTopActionExecutor } from './executor.js'
export type { HrcTopExecutorOptions } from './executor.js'
export { applyFilter } from './filter.js'
export type { HrcTopFilterRow, HrcTopFilterResult } from './filter.js'
export { interpretHrcTopKey } from './keymap.js'
export type { HrcTopKeyIntent, HrcTopKeyPrefix } from './keymap.js'
export { selectFilteredVisibleRows, selectVisibleTriageRowIds } from './render.js'
export {
  groupTriageRows,
  triageBucketFor,
  triageCounts,
  isActionableBucket,
  TRIAGE_BUCKET_ORDER,
} from './triage.js'
export type {
  HrcTopTriageBucket,
  HrcTopTriageGroup,
  HrcTopTriageRow,
  HrcTopTriageCounts,
} from './triage.js'
export { PALETTE, createPainter, stateColorHex } from './theme.js'
export type { Painter, StyleSpec } from './theme.js'
export { buildFocusPanelModel } from './focus.js'
export { buildInspectPanelModel } from './inspect.js'
export { createNavState, reduceNavState } from './nav-state.js'
export { buildTopScreenModel, renderTopScreen, renderTopScreenModel } from './render.js'
export type { HrcTopFocusInput, HrcTopFocusPanelModel } from './focus.js'
export type { HrcTopInspectInput, HrcTopInspectPanelModel } from './inspect.js'
export type { HrcTopNavState, HrcTopVisibleRow } from './nav-state.js'
export type {
  HrcTopRenderInput,
  HrcTopScreenModel,
  HrcTopRenderedRow,
  HrcTopTriageSection,
} from './render.js'
export type {
  HrcTopHeaderCounts,
  HrcTopLastActivity,
  HrcTopReadModel,
  HrcTopRow,
  HrcTopScope,
} from './read-model.js'

export class HrcTopTerminalInputDecoder {
  private state: HrcTopTerminalInputState = 'normal'
  private csiBytes: number[] = []
  private legacyMouseBytesRemaining = 0

  feed(chunk: Buffer | string): string[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const keys: string[] = []

    for (const byte of bytes) {
      if (this.legacyMouseBytesRemaining > 0) {
        this.legacyMouseBytesRemaining -= 1
        continue
      }

      if (this.state === 'normal') {
        if (byte === 0x1b) {
          this.state = 'escape'
          continue
        }
        keys.push(String.fromCharCode(byte))
        continue
      }

      if (this.state === 'escape') {
        if (byte === 0x5b) {
          this.state = 'csi'
          this.csiBytes = []
          continue
        }
        if (byte === 0x4f) {
          this.state = 'ss3'
          continue
        }
        if (byte === 0x5d) {
          this.state = 'osc'
          continue
        }
        keys.push('\u001b', String.fromCharCode(byte))
        this.reset()
        continue
      }

      if (this.state === 'csi') {
        this.csiBytes.push(byte)
        if (isAnsiFinalByte(byte)) {
          const isLegacyMouse = byte === 0x4d && this.csiBytes.length === 1
          this.reset()
          if (isLegacyMouse) this.legacyMouseBytesRemaining = 3
        }
        continue
      }

      if (this.state === 'ss3') {
        this.reset()
        continue
      }

      if (this.state === 'osc') {
        if (byte === 0x07) {
          this.reset()
          continue
        }
        if (byte === 0x1b) {
          this.state = 'oscEscape'
          continue
        }
        continue
      }

      if (this.state === 'oscEscape') {
        if (byte === 0x5c) {
          this.reset()
          continue
        }
        this.state = byte === 0x1b ? 'oscEscape' : 'osc'
      }
    }

    return keys
  }

  flushPendingEscape(): string[] {
    if (this.state !== 'escape') return []
    this.reset()
    return ['\u001b']
  }

  reset(): void {
    this.state = 'normal'
    this.csiBytes = []
    this.legacyMouseBytesRemaining = 0
  }
}

export function drainHrcTopPendingInput(
  input: Pick<NodeJS.ReadStream, 'read'>,
  decoder: HrcTopTerminalInputDecoder
): number {
  let drained = 0
  while (true) {
    const chunk = input.read()
    if (chunk === null || chunk === undefined) break
    drained += 1
    decoder.feed(Buffer.isBuffer(chunk) ? chunk : String(chunk))
  }
  decoder.reset()
  return drained
}

export function restoreHrcTopTerminalAfterSpawn(input: {
  input: HrcTopTerminalInput
  output: HrcTopTerminalOutput
  decoder: HrcTopTerminalInputDecoder
  redraw: () => void
}): number {
  input.input.setRawMode?.(true)
  const drained = drainHrcTopPendingInput(input.input, input.decoder)
  input.input.resume()
  input.output.write('\u001b[?25l')
  input.redraw()
  return drained
}

export async function runHrcTop(options: HrcTopOptions = {}): Promise<void> {
  const client = options.client ?? new HrcClient(options.socketPath ?? discoverSocket())
  const output = options.output ?? process.stdout
  const input = options.input ?? process.stdin
  const model = await loadReadModel(client, options)
  const interactive = isInteractive(input, output)
  const navState = createNavState({
    visibleRows: visibleRowsFor(model, '', !interactive),
    viewportHeight: viewportHeight(output),
  })

  if (!interactive) {
    // Piped / non-TTY: dump the full list (no idle collapse), no ANSI color.
    output.write(render(model, navState, output, { showAll: true, color: false }))
    return
  }

  await runInteractiveTop({
    client,
    options,
    input,
    output,
    initialModel: model,
    initialNavState: navState,
  })
}

type InteractiveTopInput = {
  client: HrcTopClient
  options: HrcTopOptions
  input: NodeJS.ReadStream
  output: NodeJS.WritableStream
  initialModel: HrcTopReadModel
  initialNavState: HrcTopNavState
}

async function runInteractiveTop(input: InteractiveTopInput): Promise<void> {
  const { client, options, output } = input
  const ttyInput = input.input
  let model = input.initialModel
  let navState = input.initialNavState
  let focusMode = false
  let inspectMode = false
  let showAll = false
  let showHelp = false
  let filterText = ''
  let filterMode = false
  let commandText = ''
  let commandMode = false
  let notice: string | undefined
  let pendingRunConfirmationRowId: string | undefined
  let keyPrefix: HrcTopKeyPrefix
  const terminalInput = new HrcTopTerminalInputDecoder()
  let closed = false
  let suspendedForSpawn = false
  let resolveClosed: (() => void) | undefined
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const previousRawMode = ttyInput.isRaw
  ttyInput.setRawMode?.(true)
  ttyInput.resume()
  output.write('\u001b[?25l')

  const redraw = () => {
    if (suspendedForSpawn) return
    output.write('\u001b[H\u001b[2J')
    output.write(
      render(model, navState, output, {
        focusMode,
        inspectMode,
        showAll,
        showHelp,
        notice,
        filterText,
        filterMode,
        commandText,
        commandMode,
        color: true,
      })
    )
  }

  const executor = createHrcTopActionExecutor(requireActionClient(client), {
    beforeSpawn: () => {
      suspendedForSpawn = true
      terminalInput.reset()
      ttyInput.pause()
      ttyInput.setRawMode?.(false)
      output.write('\u001b[?25h\n')
    },
    afterSpawn: () => {
      if (closed) return
      suspendedForSpawn = false
      restoreHrcTopTerminalAfterSpawn({
        input: ttyInput,
        output,
        decoder: terminalInput,
        redraw,
      })
    },
  })

  const recomputeNav = () => {
    navState = reduceNavState(
      navState,
      { type: 'refresh' },
      {
        visibleRows: visibleRowsFor(model, filterText, showAll),
        viewportHeight: viewportHeight(output),
      }
    )
  }

  const refresh = async () => {
    if (suspendedForSpawn) return
    try {
      model = await loadReadModel(client, options)
      recomputeNav()
      redraw()
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error)
      redraw()
    }
  }

  const stop = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    ttyInput.off('data', onData)
    ttyInput.setRawMode?.(previousRawMode ?? false)
    ttyInput.pause()
    output.write('\u001b[?25h')
    output.write('\n')
    resolveClosed?.()
  }

  const handleActionResult = async (result: HrcTopActionResult, selectedRowId?: string) => {
    notice = result.reason
    if (result.status === 'confirmation_required') {
      pendingRunConfirmationRowId = selectedRowId
      redraw()
      return
    }
    pendingRunConfirmationRowId = undefined

    if (result.status === 'quit') {
      stop()
      return
    }
    if (result.status === 'filter_changed') {
      filterText = result.filterText ?? ''
      recomputeNav()
    }
    if (result.action === 'focus') {
      focusMode = true
      inspectMode = false
    }
    if (result.action === 'inspect') {
      inspectMode = true
      focusMode = false
    }
    if (result.status === 'executed') {
      await refresh()
      return
    }
    redraw()
  }

  const handleActionKey = async (key: string) => {
    try {
      const row = selectedRow()
      if (!row) {
        notice = 'No target selected.'
        redraw()
        return
      }
      const confirmRunWithContinuation = key === 'R' && pendingRunConfirmationRowId === row.id
      const result = await dispatchHrcTopActionKey({
        key,
        row,
        executor,
        confirmRunWithContinuation,
      })
      await handleActionResult(result, row.id)
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error)
      redraw()
    }
  }

  const handleIntent = (intent: HrcTopKeyIntent) => {
    notice = undefined
    if (intent.type === 'quit') {
      if (commandMode) {
        commandMode = false
        commandText = ''
        redraw()
        return
      }
      if (inspectMode) {
        inspectMode = false
        redraw()
        return
      }
      if (focusMode) {
        focusMode = false
        redraw()
        return
      }
      stop()
      return
    }
    if (intent.type === 'focus') {
      focusMode = true
      inspectMode = false
      redraw()
      return
    }
    if (intent.type === 'help') {
      showHelp = !showHelp
      redraw()
      return
    }
    if (intent.type === 'noop') {
      notice = intent.reason
      redraw()
      return
    }
    if (intent.type === 'filter') {
      filterMode = true
      redraw()
      return
    }
    if (intent.type === 'toggleShowAll') {
      showAll = !showAll
      recomputeNav()
      redraw()
      return
    }
    if (intent.type === 'command') {
      commandMode = true
      commandText = ''
      redraw()
      return
    }
    if (intent.type === 'action') {
      void handleActionKey(intent.key)
      return
    }
    if (intent.type === 'searchNext' || intent.type === 'searchPrev') {
      const filtered = visibleRowsFor(model, filterText, showAll)
      const bodyHeight = Math.max(1, viewportHeight(output) - 8)
      if (filterText.trim().length === 0 || filtered.length <= bodyHeight) {
        notice = 'n/N search only moves when a filter narrows past the viewport'
        redraw()
        return
      }
      navState = reduceNavState(
        navState,
        { type: 'key', key: intent.type === 'searchNext' ? 'j' : 'k' },
        { visibleRows: filtered, viewportHeight: viewportHeight(output) }
      )
      redraw()
      return
    }

    navState = reduceNavState(navState, intent, {
      visibleRows: visibleRowsFor(model, filterText, showAll),
      viewportHeight: viewportHeight(output),
    })
    redraw()
  }

  const handleFilterKey = (inputChar: string) => {
    notice = undefined
    const code = inputChar.charCodeAt(0)
    // Ctrl-C always quits.
    if (code === 3) {
      stop()
      return
    }
    // Enter or Esc exit filter ENTRY but keep the current filter.
    if (inputChar === '\r' || inputChar === '\n' || code === 27) {
      filterMode = false
      recomputeNav()
      redraw()
      return
    }
    // Backspace / DEL edits the query; emptying it restores all rows.
    if (code === 127 || code === 8) {
      filterText = filterText.slice(0, -1)
      recomputeNav()
      redraw()
      return
    }
    // Printable characters extend the query.
    if (code >= 32) {
      filterText += inputChar
      recomputeNav()
      redraw()
      return
    }
  }

  const handleCommandKey = (inputChar: string) => {
    notice = undefined
    const code = inputChar.charCodeAt(0)
    if (code === 3) {
      stop()
      return
    }
    if (code === 27) {
      commandMode = false
      commandText = ''
      redraw()
      return
    }
    if (inputChar === '\r' || inputChar === '\n') {
      const line = `:${commandText}`
      commandMode = false
      commandText = ''
      const row = selectedRow()
      if (!row) {
        notice = 'No target selected.'
        redraw()
        return
      }
      void executeHrcTopCommandLine({ line, row, executor })
        .then((result) => handleActionResult(result, row.id))
        .catch((error: unknown) => {
          notice = error instanceof Error ? error.message : String(error)
          redraw()
        })
      return
    }
    if (code === 127 || code === 8) {
      commandText = commandText.slice(0, -1)
      redraw()
      return
    }
    if (code >= 32) {
      commandText += inputChar
      redraw()
      return
    }
  }

  const selectedRow = (): HrcTopRow | undefined => {
    const selectedId =
      navState.selectedRowId ??
      visibleRowsFor(model, filterText, showAll)[navState.selectedIndex]?.id
    if (!selectedId) return undefined
    return model.rows.find((row) => row.id === selectedId)
  }

  const onData = (chunk: Buffer) => {
    if (suspendedForSpawn) {
      terminalInput.reset()
      return
    }

    let inputChars = terminalInput.feed(chunk)
    if (inputChars.length === 0 && (commandMode || filterMode)) {
      inputChars = terminalInput.flushPendingEscape()
    }

    for (const inputChar of inputChars) {
      if (commandMode) {
        handleCommandKey(inputChar)
        continue
      }
      if (filterMode) {
        handleFilterKey(inputChar)
        continue
      }
      const result = interpretHrcTopKey(inputChar, keyPrefix)
      keyPrefix = result.prefix
      if (result.intent) handleIntent(result.intent)
    }
  }

  const timer = setInterval(refresh, Math.max(500, options.pollIntervalMs ?? 3_000))
  ttyInput.on('data', onData)
  redraw()

  await closedPromise
}

function render(
  model: HrcTopReadModel,
  navState: HrcTopNavState,
  output: NodeJS.WritableStream,
  options: {
    focusMode?: boolean | undefined
    inspectMode?: boolean | undefined
    showAll?: boolean | undefined
    showHelp?: boolean | undefined
    notice?: string | undefined
    filterText?: string | undefined
    filterMode?: boolean | undefined
    commandText?: string | undefined
    commandMode?: boolean | undefined
    color?: boolean | undefined
  } = {}
): string {
  return renderTopScreen({
    model,
    navState,
    viewportHeight: viewportHeight(output),
    width: terminalWidth(output),
    filterText: options.filterText,
    filterMode: options.filterMode,
    commandText: options.commandText,
    commandMode: options.commandMode,
    focusMode: options.focusMode,
    inspectMode: options.inspectMode,
    showAll: options.showAll,
    showHelp: options.showHelp,
    notice: options.notice,
    color: options.color,
  })
}

function visibleRowsFor(
  model: HrcTopReadModel,
  filterText = '',
  showAll = false
): { id: string }[] {
  return selectVisibleTriageRowIds(model, { filterText, showAll })
}

function isInteractive(input: NodeJS.ReadStream, output: NodeJS.WritableStream): boolean {
  return (
    input.isTTY === true &&
    (output as NodeJS.WriteStream).isTTY === true &&
    typeof input.setRawMode === 'function'
  )
}

function viewportHeight(output: NodeJS.WritableStream): number {
  return Math.max(8, (output as NodeJS.WriteStream).rows ?? 24)
}

function terminalWidth(output: NodeJS.WritableStream): number {
  return Math.max(60, (output as NodeJS.WriteStream).columns ?? 100)
}

function isAnsiFinalByte(byte: number): boolean {
  return byte >= 0x40 && byte <= 0x7e
}

function requireActionClient(client: HrcTopClient): Pick<HrcClient, 'attachRuntime'> {
  if (typeof client.attachRuntime !== 'function') {
    return {
      async attachRuntime() {
        throw new Error('hrc top action executor requires HrcClient.attachRuntime')
      },
    }
  }
  return { attachRuntime: client.attachRuntime.bind(client) }
}
