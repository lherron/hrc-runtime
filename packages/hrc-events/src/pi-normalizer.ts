import type { HookDerivedEvent } from './events.js'

export type PiHookEnvelopeInput = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  hookData: unknown
}

export type PiSemanticEvent = {
  source: 'hook'
  eventKind: string
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  payload: HookDerivedEvent
}

export type NormalizePiHookResult = {
  source: 'hook'
  eventName: string
  events: HookDerivedEvent[]
  semanticEvents: PiSemanticEvent[]
}

function extractPiEventName(hookData: unknown): string {
  if (!hookData || typeof hookData !== 'object' || Array.isArray(hookData)) {
    return 'unknown'
  }
  const record = hookData as Record<string, unknown>
  return typeof record['eventName'] === 'string'
    ? record['eventName']
    : typeof record['event_name'] === 'string'
      ? record['event_name']
      : typeof record['type'] === 'string'
        ? record['type']
        : 'unknown'
}

export function normalizePiHookEvent(envelope: PiHookEnvelopeInput): NormalizePiHookResult {
  return {
    source: 'hook',
    eventName: extractPiEventName(envelope.hookData),
    events: [],
    semanticEvents: [],
  }
}
