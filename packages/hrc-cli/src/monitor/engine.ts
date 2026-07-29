import {
  HrcBadRequestError,
  HrcErrorCode,
  type HrcMonitorCondition,
  type HrcMonitorOutcome,
  type HrcMonitorState,
  type HrcSelector,
  MONITOR_EXIT_CODES,
  RUNTIME_STATUS_LEVEL_BY_STATUS,
  createMonitorReader,
  isResolutionError,
} from 'hrc-core'
import { POLL_MS } from '../monitor-conditions.js'
import {
  type MonitorConditionEvent,
  type MonitorConditionMember,
  monitorMember,
} from './aggregate-render.js'
import type { MonitorStateBuilder } from './arm-phase.js'
import {
  writeAllAlreadyTrueReport,
  writeExactAlreadyTrueReport,
  writeMonitorArmReport,
} from './arm-report.js'
import {
  type MonitorSelectorSpec,
  runtimeSelector,
  selectorConditionCandidates,
} from './selector-shape.js'
import { eventMatchesSelectorSet, scopeRefForSelector, selectorSetLabel } from './selector-shape.js'
import { type MonitorUntilPlan, isLevelCondition } from './until-args.js'

export type MonitorPlanRunResult = {
  exitCode: number
  event: MonitorConditionEvent
}

type MonitorPlanIo = {
  buildMonitorState: MonitorStateBuilder
  stderr: { write(chunk: string): boolean }
}

/** Shared redesigned condition path used by both `watch` and `wait`. */
export async function runMonitorUntilPlan(
  initialState: HrcMonitorState,
  plan: MonitorUntilPlan,
  inputSpecs: readonly MonitorSelectorSpec[],
  io: MonitorPlanIo,
  options: {
    timeoutMs?: number | undefined
    stallAfterMs?: number | undefined
    signal?: AbortSignal | undefined
    edgeFromSeq?: number | undefined
  } = {}
): Promise<MonitorPlanRunResult> {
  const selector = selectorSetLabel(inputSpecs)
  const specs = await bindRoleTreeConditionSelector(initialState, plan, inputSpecs)
  const armedAt = Date.now()
  const deadline = options.timeoutMs === undefined ? undefined : armedAt + options.timeoutMs
  const armHighWater = monitorHighWater(initialState)
  const edgeFromSeq = options.edgeFromSeq ?? armHighWater + 1
  const frozenRuntimeIds =
    plan.quantifier === 'all'
      ? new Set(resolveMembers(initialState, specs).map((member) => member.runtimeId))
      : undefined
  let lastProgressAt = armedAt
  let lastHighWater = armHighWater

  const armEvaluation = evaluateState(initialState, plan, specs, frozenRuntimeIds)
  writeMonitorArmReport(io.stderr, {
    selector,
    quantifier: plan.quantifier,
    conditions: plan.conditions,
    observedAt: armEvaluation.observedAt,
    members: armEvaluation.members,
    state: initialState,
  })

  if (plan.quantifier === 'exact' && armEvaluation.members.length === 0) {
    io.stderr.write(`no session has ever existed for scope ${selector}\n`)
    return completed(
      plan,
      selector,
      armEvaluation,
      'no_session_ever',
      MONITOR_EXIT_CODES.noSessionEver,
      'at-arm'
    )
  }
  const replayedEdge = matchEdgeAtOrAfter(initialState, plan, specs, edgeFromSeq)
  if (replayedEdge) {
    armEvaluation.matchedCondition = replayedEdge.condition
    armEvaluation.scopeRef = replayedEdge.scopeRef
    armEvaluation.runtimeId = replayedEdge.runtimeId
    if (replayedEdge.contextChanged) armEvaluation.contextChanged = true
    if (replayedEdge.failureResult) {
      return completed(
        plan,
        selector,
        armEvaluation,
        replayedEdge.failureResult,
        MONITOR_EXIT_CODES.terminalFailure,
        'at-arm'
      )
    }
    armEvaluation.satisfied = true
    return completed(
      plan,
      selector,
      armEvaluation,
      'matched',
      MONITOR_EXIT_CODES.matchedAfterArm,
      'at-arm'
    )
  }
  const implicitFailure = plan.implicit
    ? armEvaluation.members.find((member) => runtimeLevel(member.status) === 'runtime-dead')
    : undefined
  if (implicitFailure) {
    return completed(
      plan,
      selector,
      armEvaluation,
      implicitFailure.status === 'crashed' ? 'runtime_crashed' : 'runtime_dead',
      MONITOR_EXIT_CODES.terminalFailure,
      'at-arm'
    )
  }
  if (armEvaluation.obstructed) {
    return completed(
      plan,
      selector,
      armEvaluation,
      'runtime_death_obstruction',
      MONITOR_EXIT_CODES.runtimeDeathObstruction,
      'at-arm'
    )
  }
  if (armEvaluation.satisfied) {
    if (plan.quantifier === 'all') {
      writeAllAlreadyTrueReport(io.stderr, armEvaluation.matchedCondition, armEvaluation.members)
    } else if (
      plan.quantifier === 'exact' &&
      armEvaluation.members[0] &&
      armEvaluation.matchedCondition
    ) {
      writeExactAlreadyTrueReport(
        io.stderr,
        armEvaluation.members[0],
        armEvaluation.matchedCondition
      )
    }
    return completed(
      plan,
      selector,
      armEvaluation,
      'already_true',
      MONITOR_EXIT_CODES.alreadyTrueAtArm,
      'at-arm'
    )
  }

  let state = initialState
  while (!options.signal?.aborted) {
    const now = Date.now()
    if (deadline !== undefined && now >= deadline) {
      const evaluation = evaluateState(state, plan, specs, frozenRuntimeIds)
      return completed(
        plan,
        selector,
        evaluation,
        'timeout',
        MONITOR_EXIT_CODES.timeout,
        'after-arm'
      )
    }
    if (options.stallAfterMs !== undefined && now - lastProgressAt >= options.stallAfterMs) {
      const evaluation = evaluateState(state, plan, specs, frozenRuntimeIds)
      return completed(plan, selector, evaluation, 'stalled', MONITOR_EXIT_CODES.stall, 'after-arm')
    }

    await delay(Math.min(POLL_MS, Math.max(1, deadline === undefined ? POLL_MS : deadline - now)))
    if (options.signal?.aborted) break
    try {
      state = await io.buildMonitorState(options.signal)
    } catch {
      const evaluation = evaluateState(state, plan, specs, frozenRuntimeIds)
      return completed(
        plan,
        selector,
        evaluation,
        'monitor_error',
        MONITOR_EXIT_CODES.monitorError,
        'after-arm'
      )
    }

    const highWater = monitorHighWater(state)
    if (highWater > lastHighWater) {
      lastHighWater = highWater
      lastProgressAt = Date.now()
    }
    const evaluation = evaluateState(state, plan, specs, frozenRuntimeIds)
    const edgeMatch = matchEdgeAtOrAfter(state, plan, specs, edgeFromSeq)
    if (edgeMatch) {
      if (edgeMatch.contextChanged) {
        evaluation.contextChanged = true
      } else if (edgeMatch.failureResult) {
        evaluation.matchedCondition = edgeMatch.condition
        evaluation.scopeRef = edgeMatch.scopeRef
        evaluation.runtimeId = edgeMatch.runtimeId
        return completed(
          plan,
          selector,
          evaluation,
          edgeMatch.failureResult,
          MONITOR_EXIT_CODES.terminalFailure,
          'after-arm'
        )
      } else {
        evaluation.satisfied = true
        evaluation.matchedCondition = edgeMatch.condition
        evaluation.scopeRef = edgeMatch.scopeRef
        evaluation.runtimeId = edgeMatch.runtimeId
      }
    }
    if (evaluation.contextChanged) {
      return completed(
        plan,
        selector,
        evaluation,
        'context_changed',
        MONITOR_EXIT_CODES.contextChange,
        'after-arm'
      )
    }
    if (evaluation.obstructed) {
      return completed(
        plan,
        selector,
        evaluation,
        'runtime_death_obstruction',
        MONITOR_EXIT_CODES.runtimeDeathObstruction,
        'after-arm'
      )
    }
    if (evaluation.satisfied) {
      return completed(
        plan,
        selector,
        evaluation,
        'matched',
        MONITOR_EXIT_CODES.matchedAfterArm,
        'after-arm'
      )
    }
  }

  const evaluation = evaluateState(state, plan, specs, frozenRuntimeIds)
  return completed(plan, selector, evaluation, 'interrupted', 130, 'after-arm')
}

async function bindRoleTreeConditionSelector(
  state: HrcMonitorState,
  plan: MonitorUntilPlan,
  specs: readonly MonitorSelectorSpec[]
): Promise<readonly MonitorSelectorSpec[]> {
  if (plan.quantifier !== 'exact' || specs.length !== 1) return specs
  const spec = specs[0]
  if (
    spec?.kind !== 'exact' ||
    (spec.selector.kind !== 'target' && spec.selector.kind !== 'scope')
  ) {
    return specs
  }

  const capture = await createMonitorReader(state).captureStart(spec.selector)
  if (isResolutionError(capture)) {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      capture.error.message,
      capture.error.detail
    )
  }
  return [
    {
      kind: 'exact',
      raw: spec.raw,
      selector: runtimeSelector(capture.runtimeId),
    },
  ]
}

type StateEvaluation = {
  observedAt: string
  members: MonitorConditionMember[]
  satisfied: boolean
  obstructed: boolean
  contextChanged: boolean
  matchedCondition?: string | undefined
  scopeRef?: string | undefined
  runtimeId?: string | undefined
}

function evaluateState(
  state: HrcMonitorState,
  plan: MonitorUntilPlan,
  specs: readonly MonitorSelectorSpec[],
  frozenRuntimeIds: ReadonlySet<string> | undefined
): StateEvaluation {
  const resolved = resolveMembers(state, specs).filter(
    (member) => frozenRuntimeIds === undefined || frozenRuntimeIds.has(member.runtimeId)
  )
  const members = resolved.map((entry) => {
    const matchedCondition = matchRuntimeLevel(entry.status, plan.conditions)
    return monitorMember(entry.runtime, entry.scopeRef, matchedCondition)
  })
  const matched = members.filter((member) => member.matchedCondition !== undefined)
  const satisfied =
    plan.quantifier === 'all'
      ? members.length > 0 && matched.length === members.length
      : matched.length > 0
  const deadIsNamed = !plan.implicit && plan.conditions.includes('runtime-dead')
  const deadMembers = members.filter((member) => runtimeLevel(member.status) === 'runtime-dead')
  const obstructed = !deadIsNamed && plan.quantifier !== 'any' && deadMembers.length > 0
  const frozenMemberMissing =
    frozenRuntimeIds !== undefined && members.length < frozenRuntimeIds.size
  const representative = plan.quantifier === 'all' ? undefined : matched[0]
  return {
    observedAt: new Date().toISOString(),
    members,
    satisfied,
    obstructed,
    contextChanged: frozenMemberMissing,
    matchedCondition:
      plan.quantifier === 'all' && satisfied
        ? commonMatchedCondition(matched)
        : representative?.matchedCondition,
    scopeRef: representative?.scopeRef,
    runtimeId: representative?.runtimeId,
  }
}

function resolveMembers(
  state: HrcMonitorState,
  specs: readonly MonitorSelectorSpec[]
): Array<{
  runtimeId: string
  status: string
  runtime: HrcMonitorState['runtimes'][number]
  scopeRef: string
}> {
  const members = new Map<
    string,
    {
      runtimeId: string
      status: string
      runtime: HrcMonitorState['runtimes'][number]
      scopeRef: string
    }
  >()
  for (const candidate of selectorConditionCandidates(state, specs)) {
    const runtime = runtimeForSelector(state, candidate.selector)
    if (!runtime) continue
    const scopeRef =
      candidate.scopeRef || runtime.scopeRef || scopeRefForSelector(state, candidate.selector) || ''
    members.set(runtime.runtimeId, {
      runtimeId: runtime.runtimeId,
      status: runtime.status,
      runtime,
      scopeRef,
    })
  }
  return [...members.values()]
}

function runtimeForSelector(state: HrcMonitorState, selector: HrcSelector) {
  if (selector.kind === 'runtime') {
    return state.runtimes.find((runtime) => runtime.runtimeId === selector.runtimeId)
  }
  if (selector.kind === 'host' || selector.kind === 'concrete') {
    return state.runtimes
      .filter((runtime) => runtime.hostSessionId === selector.hostSessionId)
      .at(-1)
  }
  if (selector.kind === 'message' || selector.kind === 'message-seq') {
    const message = state.messages?.find((entry) =>
      selector.kind === 'message'
        ? entry.messageId === selector.messageId
        : entry.messageSeq === selector.messageSeq
    )
    return state.runtimes.find((runtime) => runtime.runtimeId === message?.runtimeId)
  }
  const scopeRef = scopeRefForSelector(state, selector)
  const session = state.sessions.filter((entry) => entry.scopeRef === scopeRef).at(-1)
  return state.runtimes.find((runtime) => runtime.runtimeId === session?.runtimeId)
}

function matchRuntimeLevel(
  status: string,
  conditions: readonly HrcMonitorCondition[]
): string | undefined {
  const level = runtimeLevel(status)
  return conditions.find((condition) => isLevelCondition(condition) && condition === level)
}

function runtimeLevel(status: string): string | null {
  return (
    (RUNTIME_STATUS_LEVEL_BY_STATUS as Record<string, string | null | undefined>)[status] ?? null
  )
}

function commonMatchedCondition(members: readonly MonitorConditionMember[]): string | undefined {
  const first = members[0]?.matchedCondition
  return first !== undefined && members.every((member) => member.matchedCondition === first)
    ? first
    : undefined
}

function matchEdgeAtOrAfter(
  state: HrcMonitorState,
  plan: MonitorUntilPlan,
  specs: readonly MonitorSelectorSpec[],
  fromSeq: number
):
  | {
      condition?: string | undefined
      scopeRef?: string | undefined
      runtimeId?: string | undefined
      contextChanged?: boolean | undefined
      failureResult?: 'turn_failed' | 'runtime_dead' | 'runtime_crashed' | undefined
    }
  | undefined {
  for (const event of state.events) {
    if (event.seq < fromSeq || !eventMatchesSelectorSet(state, event, specs)) continue
    const name = event['eventKind'] ?? event.event
    if (
      plan.conditions.includes('turn-finished') &&
      (name === 'turn.finished' || name === 'turn.completed' || name === 'turn.failed')
    ) {
      const rawResult = String(event['result'] ?? '')
      const failureResult =
        name === 'turn.failed'
          ? 'turn_failed'
          : rawResult === 'turn_failed' ||
              rawResult === 'runtime_dead' ||
              rawResult === 'runtime_crashed'
            ? rawResult
            : undefined
      return {
        condition: 'turn-finished',
        scopeRef: event.scopeRef,
        runtimeId: event.runtimeId,
        ...(failureResult ? { failureResult } : {}),
      }
    }
    if (plan.implicit && (name === 'runtime.dead' || name === 'runtime.crashed')) {
      return {
        condition: 'runtime-dead',
        scopeRef: event.scopeRef,
        runtimeId: event.runtimeId,
        failureResult: name === 'runtime.crashed' ? 'runtime_crashed' : 'runtime_dead',
      }
    }
    if (plan.conditions.includes('response') && name === 'message.response') {
      return { condition: 'response', scopeRef: event.scopeRef, runtimeId: event.runtimeId }
    }
    if (String(event['result'] ?? '') === 'context_changed') return { contextChanged: true }
  }
  return undefined
}

function completed(
  plan: MonitorUntilPlan,
  selector: string,
  evaluation: StateEvaluation,
  result: string,
  exitCode: number,
  phase: 'at-arm' | 'after-arm'
): MonitorPlanRunResult {
  const event: MonitorConditionEvent = {
    event: result === 'stalled' ? 'monitor.stalled' : 'monitor.completed',
    selector,
    quantifier: plan.quantifier,
    conditions: [...plan.conditions],
    phase,
    observedAt: evaluation.observedAt,
    members: evaluation.members,
    result,
    outcome: monitorOutcome(exitCode),
    exitCode,
    ...(evaluation.matchedCondition ? { matchedCondition: evaluation.matchedCondition } : {}),
    ...(evaluation.scopeRef ? { scopeRef: evaluation.scopeRef } : {}),
    ...(evaluation.runtimeId ? { runtimeId: evaluation.runtimeId } : {}),
    replayed: false,
    ts: evaluation.observedAt,
  }
  return { exitCode, event }
}

function monitorOutcome(exitCode: number): HrcMonitorOutcome {
  if (
    exitCode === MONITOR_EXIT_CODES.matchedAfterArm ||
    exitCode === MONITOR_EXIT_CODES.alreadyTrueAtArm
  ) {
    return 'success'
  }
  if (exitCode === MONITOR_EXIT_CODES.terminalFailure) return 'observed_failure'
  if (exitCode === MONITOR_EXIT_CODES.monitorError || exitCode === 130) return 'error'
  return 'not_matched'
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
