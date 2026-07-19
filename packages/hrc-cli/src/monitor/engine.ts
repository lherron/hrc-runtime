import {
  type HrcMonitorCondition,
  type HrcMonitorConditionEngineReader,
  type HrcMonitorConditionOutcome,
  type HrcMonitorConditionWaitRequest,
  type HrcMonitorState,
  type HrcSelector,
  createMonitorConditionEngine,
} from 'hrc-core'
import { POLL_MS } from '../monitor-conditions.js'
import { type TerminalFence, resolveTerminalFence } from '../monitor-terminal-fence.js'
import { type MonitorStateBuilder, createArmPhaseReader } from './arm-phase.js'
import {
  type MonitorSelectorSpec,
  type SelectorConditionCandidate,
  runtimeSelector,
  selectorConditionCandidates,
} from './selector-shape.js'

export type MonitorConditionArgs = {
  until?: string | undefined
  timeoutMs?: number | undefined
  stallAfterMs?: number | undefined
  signal?: AbortSignal | undefined
  since?: string | undefined
  terminalFence?: TerminalFence | undefined
}

export type AnyMonitorConditionResult = {
  outcome: HrcMonitorConditionOutcome
  selector: HrcSelector
  scopeRef: string
}

/** The single condition-engine invocation path used by both monitor verbs. */
export function waitForMonitorCondition(
  reader: HrcMonitorConditionEngineReader,
  request: HrcMonitorConditionWaitRequest
): Promise<HrcMonitorConditionOutcome> {
  return createMonitorConditionEngine(reader).wait(request)
}

function isDecisiveConditionOutcome(outcome: HrcMonitorConditionOutcome): boolean {
  return (
    outcome.result !== 'timeout' &&
    outcome.result !== 'stalled' &&
    outcome.result !== 'monitor_error'
  )
}

export async function waitForAnyMonitorCondition(
  initialState: HrcMonitorState,
  args: MonitorConditionArgs,
  specs: readonly MonitorSelectorSpec[],
  io: { buildMonitorState: MonitorStateBuilder }
): Promise<AnyMonitorConditionResult> {
  const condition = args.until as HrcMonitorCondition
  const terminalFence =
    condition === 'terminal'
      ? (args.terminalFence ?? resolveTerminalFence(initialState, args.since))
      : undefined
  const startedAt = Date.now()
  const deadline = args.timeoutMs === undefined ? undefined : startedAt + args.timeoutMs
  const controller = new AbortController()
  const seen = new Set<string>()
  let fallback: AnyMonitorConditionResult | undefined

  return await new Promise<AnyMonitorConditionResult>((resolve) => {
    let settled = false
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      finish({
        outcome: { result: 'monitor_error', exitCode: 130 },
        selector: runtimeSelector('aborted'),
        scopeRef: '',
      })
    }
    const finish = (result: AnyMonitorConditionResult): void => {
      if (settled) return
      settled = true
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      args.signal?.removeEventListener('abort', onAbort)
      controller.abort()
      resolve(result)
    }
    if (deadline !== undefined) {
      deadlineTimer = setTimeout(
        () => {
          finish(
            fallback ?? {
              outcome: { result: 'timeout', exitCode: 1 },
              selector: runtimeSelector('unresolved'),
              scopeRef: '',
            }
          )
        },
        Math.max(0, deadline - Date.now())
      )
    }
    args.signal?.addEventListener('abort', onAbort, { once: true })
    if (args.signal?.aborted) onAbort()
    const startCandidate = (
      candidate: SelectorConditionCandidate,
      state: HrcMonitorState
    ): void => {
      if (seen.has(candidate.key)) return
      seen.add(candidate.key)
      const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now())
      void waitForMonitorCondition(
        createArmPhaseReader(state, io.buildMonitorState, {
          firstRead: 'refresh',
          signal: controller.signal,
        }),
        {
          selector: candidate.selector,
          condition,
          timeoutMs: remaining,
          stallAfterMs: args.stallAfterMs,
          ...(terminalFence ? { terminalFence } : {}),
        }
      ).then((outcome) => {
        const result = { outcome, selector: candidate.selector, scopeRef: candidate.scopeRef }
        fallback ??= result
        if (isDecisiveConditionOutcome(outcome)) finish(result)
      })
    }

    void (async () => {
      let state = initialState
      while (!settled && !controller.signal.aborted) {
        for (const candidate of selectorConditionCandidates(state, specs)) {
          startCandidate(candidate, state)
        }
        if (args.signal?.aborted) {
          finish({
            outcome: { result: 'monitor_error', exitCode: 130 },
            selector: runtimeSelector('aborted'),
            scopeRef: '',
          })
          return
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          finish(
            fallback ?? {
              outcome: { result: 'timeout', exitCode: 1 },
              selector: runtimeSelector('unresolved'),
              scopeRef: '',
            }
          )
          return
        }
        await delay(POLL_MS)
        if (settled || controller.signal.aborted) return
        state = await io.buildMonitorState(controller.signal)
      }
    })().catch((error: unknown) => {
      if (settled || controller.signal.aborted) return
      finish({
        outcome: { result: 'monitor_error', exitCode: 3 },
        selector: runtimeSelector('unresolved'),
        scopeRef: '',
      })
      void error
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
