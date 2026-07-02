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
import { renderTopScreen, selectFilteredVisibleRows } from './render.js'

type HrcTopClient = Pick<HrcClient, 'listTargets'> & Partial<Pick<HrcClient, 'attachRuntime'>>

export type HrcTopOptions = HrcTopScope & {
  client?: HrcTopClient | undefined
  socketPath?: string | undefined
  output?: NodeJS.WritableStream | undefined
  input?: NodeJS.ReadStream | undefined
  pollIntervalMs?: number | undefined
}

export { buildReadModel, loadReadModel }
export { applyFilter } from './filter.js'
export type { HrcTopFilterRow, HrcTopFilterResult } from './filter.js'
export { selectFilteredVisibleRows } from './render.js'
export { buildFocusPanelModel } from './focus.js'
export { createNavState, reduceNavState } from './nav-state.js'
export { buildTopScreenModel, renderTopScreen, renderTopScreenModel } from './render.js'
export type { HrcTopFocusInput, HrcTopFocusPanelModel } from './focus.js'
export type { HrcTopNavState, HrcTopVisibleRow } from './nav-state.js'
export type { HrcTopRenderInput, HrcTopScreenModel } from './render.js'
export type {
  HrcTopHeaderCounts,
  HrcTopLastActivity,
  HrcTopReadModel,
  HrcTopRow,
} from './read-model.js'

export async function runHrcTop(options: HrcTopOptions = {}): Promise<void> {
  const client = options.client ?? new HrcClient(options.socketPath ?? discoverSocket())
  const output = options.output ?? process.stdout
  const input = options.input ?? process.stdin
  const model = await loadReadModel(client, options)
  const navState = createNavState({
    visibleRows: visibleRowsFor(model),
    viewportHeight: viewportHeight(output),
  })

  if (!isInteractive(input, output)) {
    output.write(render(model, navState, output))
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
  let showHelp = false
  let filterText = ''
  let filterMode = false
  let commandText = ''
  let commandMode = false
  let notice: string | undefined
  let pendingRunConfirmationRowId: string | undefined
  let keyPrefix: HrcTopKeyPrefix
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
        showHelp,
        notice,
        filterText,
        filterMode,
        commandText,
        commandMode,
      })
    )
  }

  const executor = createHrcTopActionExecutor(requireActionClient(client), {
    beforeSpawn: () => {
      suspendedForSpawn = true
      ttyInput.setRawMode?.(false)
      output.write('\u001b[?25h\n')
    },
    afterSpawn: () => {
      if (closed) return
      ttyInput.setRawMode?.(true)
      ttyInput.resume()
      output.write('\u001b[?25l')
      suspendedForSpawn = false
    },
  })

  const recomputeNav = () => {
    navState = reduceNavState(
      navState,
      { type: 'refresh' },
      {
        visibleRows: visibleRowsFor(model, filterText),
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
    if (result.action === 'focus' || result.action === 'inspect') {
      focusMode = true
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
      const filtered = visibleRowsFor(model, filterText)
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
      visibleRows: visibleRowsFor(model, filterText),
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
      navState.selectedRowId ?? visibleRowsFor(model, filterText)[navState.selectedIndex]?.id
    if (!selectedId) return undefined
    return model.rows.find((row) => row.id === selectedId)
  }

  const onData = (chunk: Buffer) => {
    for (const inputChar of chunk.toString('utf8')) {
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
    showHelp?: boolean | undefined
    notice?: string | undefined
    filterText?: string | undefined
    filterMode?: boolean | undefined
    commandText?: string | undefined
    commandMode?: boolean | undefined
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
    showHelp: options.showHelp,
    notice: options.notice,
  })
}

function visibleRowsFor(model: HrcTopReadModel, filterText = ''): { id: string }[] {
  return selectFilteredVisibleRows(model, filterText)
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
