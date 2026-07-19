import {
  type HrcMonitorConditionEngineReader,
  type HrcMonitorEvent,
  type HrcMonitorState,
  type HrcMonitorWatchRequest,
  createMonitorReader,
} from 'hrc-core'
import { POLL_MS } from '../monitor-conditions.js'
import { numberField } from '../monitor-fields.js'

export type MonitorStateBuilder = (signal?: AbortSignal | undefined) => Promise<HrcMonitorState>

export type MonitorStateBuildResult =
  | { kind: 'state'; state: HrcMonitorState }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

export type ArmPhaseReaderOptions = {
  /** Preserve the verb's existing first stream read while sharing arm capture. */
  firstRead: 'initial' | 'refresh'
  signal?: AbortSignal | undefined
}

/**
 * Builds the condition reader used by both monitor verbs. Snapshot and start
 * capture are always anchored to the already-built arm state.
 */
export function createArmPhaseReader(
  initialState: HrcMonitorState,
  buildMonitorState: MonitorStateBuilder,
  options: ArmPhaseReaderOptions
): HrcMonitorConditionEngineReader {
  const armedReader = createMonitorReader(initialState)
  return {
    snapshot(selector) {
      return armedReader.snapshot(selector)
    },
    captureStart(selector, captureOptions) {
      return armedReader.captureStart(selector, captureOptions)
    },
    watch(request) {
      return pollingWatch(initialState, request, buildMonitorState, options)
    },
  }
}

export async function buildMonitorStateBeforeDeadline(
  buildMonitorState: MonitorStateBuilder,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined
): Promise<MonitorStateBuildResult> {
  if (signal?.aborted) return { kind: 'aborted' }
  if (deadlineAt === undefined) {
    return { kind: 'state', state: await buildMonitorState(signal) }
  }

  const controller = new AbortController()
  let resolveAborted!: (value: MonitorStateBuildResult) => void
  const aborted = new Promise<MonitorStateBuildResult>((resolve) => {
    resolveAborted = resolve
  })
  const onAbort = (): void => {
    controller.abort()
    resolveAborted({ kind: 'aborted' })
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = new Promise<MonitorStateBuildResult>((resolve) => {
    const timer = setTimeout(
      () => {
        controller.abort()
        resolve({ kind: 'timeout' })
      },
      Math.max(0, deadlineAt - Date.now())
    )
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  })
  try {
    return await Promise.race([
      buildMonitorState(controller.signal).then(
        (state): MonitorStateBuildResult => ({ kind: 'state', state })
      ),
      timeout,
      aborted,
    ])
  } finally {
    controller.abort()
    signal?.removeEventListener('abort', onAbort)
  }
}

async function* pollingWatch(
  initialState: HrcMonitorState,
  request: HrcMonitorWatchRequest,
  buildMonitorState: MonitorStateBuilder,
  options: ArmPhaseReaderOptions
): AsyncIterable<HrcMonitorEvent | Record<string, unknown>> {
  const signal = options.signal ?? request.signal
  if (options.signal?.aborted || request.signal?.aborted) return

  let nextSeq: number
  if (options.firstRead === 'refresh') {
    const firstState = await buildMonitorState(signal)
    if (options.signal?.aborted || request.signal?.aborted) return
    const firstReader = createMonitorReader(firstState)
    nextSeq = request.fromSeq ?? 1
    for await (const event of firstReader.watch({
      selector: request.selector,
      follow: true,
      fromSeq: request.fromSeq,
    })) {
      yield event
      const seq = numberField(event, 'seq')
      if (seq !== undefined) nextSeq = Math.max(nextSeq, seq + 1)
    }
  } else {
    const initialReader = createMonitorReader(initialState)
    for await (const event of initialReader.watch({
      selector: request.selector,
      follow: false,
      fromSeq: request.fromSeq,
      includeCorrelatedMessageResponses: request.includeCorrelatedMessageResponses,
    })) {
      yield event
    }
    nextSeq = monitorHighWater(initialState) + 1
  }

  if (!request.follow) return
  while (!options.signal?.aborted && !request.signal?.aborted) {
    const state = await buildMonitorState(signal)
    if (options.signal?.aborted || request.signal?.aborted) return
    const reader = createMonitorReader(state)
    let yielded = false
    const fromSeq = nextSeq
    for await (const event of reader.watch({
      selector: request.selector,
      follow: false,
      fromSeq,
      includeCorrelatedMessageResponses: request.includeCorrelatedMessageResponses,
    })) {
      yielded = true
      const seq = numberField(event, 'seq')
      if (seq !== undefined) nextSeq = Math.max(nextSeq, seq + 1)
      yield event
    }
    if (options.firstRead === 'initial') {
      nextSeq = Math.max(nextSeq, monitorHighWater(state) + 1)
    }
    if (!yielded) await delay(POLL_MS)
  }
}

function monitorHighWater(state: HrcMonitorState): number {
  return (
    state.eventGlobalHighWaterSeq ??
    state.events.reduce((max, event) => Math.max(max, event.seq), 0)
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
