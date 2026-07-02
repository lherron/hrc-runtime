import { HrcClient, discoverSocket } from 'hrc-sdk'
import { interpretHrcTopKey } from './keymap.js'
import type { HrcTopKeyIntent, HrcTopKeyPrefix } from './keymap.js'
import { createNavState, reduceNavState } from './nav-state.js'
import type { HrcTopNavState } from './nav-state.js'
import { buildReadModel, loadReadModel } from './read-model.js'
import type { HrcTopReadModel, HrcTopScope } from './read-model.js'
import { renderTopScreen } from './render.js'

export type HrcTopOptions = HrcTopScope & {
  client?: Pick<HrcClient, 'listTargets'> | undefined
  socketPath?: string | undefined
  output?: NodeJS.WritableStream | undefined
  input?: NodeJS.ReadStream | undefined
  pollIntervalMs?: number | undefined
}

export { buildReadModel, loadReadModel }
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
  client: Pick<HrcClient, 'listTargets'>
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
  let notice: string | undefined
  let keyPrefix: HrcTopKeyPrefix
  let closed = false
  let resolveClosed: (() => void) | undefined
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const previousRawMode = ttyInput.isRaw
  ttyInput.setRawMode?.(true)
  ttyInput.resume()
  output.write('\u001b[?25l')

  const redraw = () => {
    output.write('\u001b[H\u001b[2J')
    output.write(render(model, navState, output, { focusMode, showHelp, notice }))
  }

  const refresh = async () => {
    try {
      model = await loadReadModel(client, options)
      navState = reduceNavState(
        navState,
        { type: 'refresh' },
        {
          visibleRows: visibleRowsFor(model),
          viewportHeight: viewportHeight(output),
        }
      )
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

  const handleIntent = (intent: HrcTopKeyIntent) => {
    notice = undefined
    if (intent.type === 'quit') {
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

    navState = reduceNavState(navState, intent, {
      visibleRows: visibleRowsFor(model),
      viewportHeight: viewportHeight(output),
    })
    redraw()
  }

  const onData = (chunk: Buffer) => {
    for (const inputChar of chunk.toString('utf8')) {
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
  } = {}
): string {
  return renderTopScreen({
    model,
    navState,
    viewportHeight: viewportHeight(output),
    width: terminalWidth(output),
    focusMode: options.focusMode,
    showHelp: options.showHelp,
    notice: options.notice,
  })
}

function visibleRowsFor(model: HrcTopReadModel): { id: string }[] {
  return model.rows.map((row) => ({ id: row.id }))
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
