import type { HrcMonitorEvent, HrcMonitorState, HrcSelector } from 'hrc-core'
import { parseProfileAwareSelector } from './profile-aware-selector.js'

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
