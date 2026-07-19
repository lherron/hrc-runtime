import type { HrcMonitorEvent, HrcMonitorState, HrcSelector } from 'hrc-core'
import { parseProfileAwareSelector } from '../profile-aware-selector.js'

export type MonitorSelectorSpec =
  | { kind: 'exact'; raw: string; selector: HrcSelector }
  | { kind: 'scope-prefix'; raw: string; prefix: string }
  | { kind: 'task'; raw: string; taskId: string }

const TASK_ID_PATTERN = /^T-\d+$/

export function parseMonitorSelectors(rawSelectors: readonly string[]): MonitorSelectorSpec[] {
  return rawSelectors.map((raw) => {
    if (TASK_ID_PATTERN.test(raw)) {
      return { kind: 'task', raw, taskId: raw }
    }
    if (raw.startsWith('scope:') && raw.endsWith(':*')) {
      const prefix = raw.slice('scope:'.length, -1)
      if (!prefix) throw new Error('scope prefix cannot be empty')
      return { kind: 'scope-prefix', raw, prefix }
    }
    return { kind: 'exact', raw, selector: parseProfileAwareSelector(raw) }
  })
}

export function isFanInSelectorSet(specs: readonly MonitorSelectorSpec[]): boolean {
  return specs.length > 1 || specs.some((spec) => spec.kind !== 'exact')
}

export function selectorSetLabel(specs: readonly MonitorSelectorSpec[]): string {
  return specs.map((spec) => spec.raw).join(',')
}

export function scopeMatchesSelectorSpec(scopeRef: string, spec: MonitorSelectorSpec): boolean {
  if (spec.kind === 'scope-prefix') return scopeRef.startsWith(spec.prefix)
  if (spec.kind === 'task') {
    const segment = `:task:${spec.taskId}`
    return scopeRef.includes(`${segment}:`) || scopeRef.endsWith(segment)
  }
  return spec.selector.kind === 'scope' && scopeRef === spec.selector.scopeRef
}

export type SelectorConditionCandidate = {
  key: string
  selector: HrcSelector
  scopeRef: string
}

export function runtimeSelector(runtimeId: string): HrcSelector {
  return { kind: 'runtime', raw: `runtime:${runtimeId}`, runtimeId }
}

function hostSelector(hostSessionId: string): HrcSelector {
  return { kind: 'host', raw: `host:${hostSessionId}`, hostSessionId }
}

export function scopeRefForSelector(
  state: HrcMonitorState,
  selector: HrcSelector
): string | undefined {
  if (selector.kind === 'scope' || selector.kind === 'target' || selector.kind === 'session') {
    return selector.scopeRef
  }
  if (selector.kind === 'runtime') {
    const runtime = state.runtimes.find((candidate) => candidate.runtimeId === selector.runtimeId)
    return state.sessions.find((session) => session.hostSessionId === runtime?.hostSessionId)
      ?.scopeRef
  }
  if (selector.kind === 'host' || selector.kind === 'concrete') {
    return state.sessions.find((session) => session.hostSessionId === selector.hostSessionId)
      ?.scopeRef
  }
  if (selector.kind === 'stable') {
    return state.sessions.find((session) => session.sessionRef === selector.sessionRef)?.scopeRef
  }
  return undefined
}

export function selectorConditionCandidates(
  state: HrcMonitorState,
  specs: readonly MonitorSelectorSpec[]
): SelectorConditionCandidate[] {
  const candidates = new Map<string, SelectorConditionCandidate>()
  for (const spec of specs) {
    if (spec.kind === 'exact') {
      const scopeRef = scopeRefForSelector(state, spec.selector)
      candidates.set(spec.raw, {
        key: spec.raw,
        selector: spec.selector,
        scopeRef: scopeRef ?? '',
      })
      continue
    }
    for (const session of state.sessions) {
      if (!scopeMatchesSelectorSpec(session.scopeRef, spec)) continue
      const selector = session.runtimeId
        ? runtimeSelector(session.runtimeId)
        : hostSelector(session.hostSessionId)
      candidates.set(session.hostSessionId, {
        key: session.hostSessionId,
        selector,
        scopeRef: session.scopeRef,
      })
    }
  }
  return [...candidates.values()]
}

function exactEventMatch(
  state: HrcMonitorState,
  event: HrcMonitorEvent,
  selector: HrcSelector
): boolean {
  switch (selector.kind) {
    case 'stable':
    case 'target':
    case 'session':
      return event.sessionRef === selector.sessionRef
    case 'concrete':
    case 'host':
      return event.hostSessionId === selector.hostSessionId
    case 'runtime':
      return event.runtimeId === selector.runtimeId
    case 'scope':
      return event.scopeRef === selector.scopeRef
    case 'message': {
      const message = state.messages?.find(
        (candidate) => candidate.messageId === selector.messageId
      )
      return (
        event.messageId === selector.messageId ||
        (message?.runtimeId !== undefined && event.runtimeId === message.runtimeId)
      )
    }
    case 'message-seq': {
      const message = state.messages?.find(
        (candidate) => candidate.messageSeq === selector.messageSeq
      )
      return (
        event.messageSeq === selector.messageSeq ||
        (message?.runtimeId !== undefined && event.runtimeId === message.runtimeId)
      )
    }
  }
}

export function eventMatchesSelectorSet(
  state: HrcMonitorState,
  event: HrcMonitorEvent,
  specs: readonly MonitorSelectorSpec[]
): boolean {
  if (specs.length === 0) return true
  return specs.some((spec) =>
    spec.kind === 'exact'
      ? exactEventMatch(state, event, spec.selector)
      : scopeMatchesSelectorSpec(event.scopeRef ?? '', spec)
  )
}
