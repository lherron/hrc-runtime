import {
  formatScopeHandle,
  formatSessionHandle,
  parseScopeRef,
  parseSessionHandle,
  validateLaneRef,
  validateScopeRef,
} from 'agent-scope'

import { HrcBadRequestError, HrcErrorCode } from './errors.js'

export type HrcSessionRef = string

export type HrcStableSelector = {
  kind: 'stable'
  sessionRef: HrcSessionRef
}

export type HrcConcreteSelector = {
  kind: 'concrete'
  hostSessionId: string
}

export type HrcTargetSelector = {
  kind: 'target'
  raw: string
  scopeRef: string
  sessionRef: HrcSessionRef
  scopeHandle: string
  sessionHandle: string
}

export type HrcScopeSelector = {
  kind: 'scope'
  raw: string
  scopeRef: string
  scopeHandle: string
}

export type HrcSessionSelector = {
  kind: 'session'
  raw: string
  scopeRef: string
  sessionRef: HrcSessionRef
  scopeHandle: string
  sessionHandle: string
}

export type HrcHostSelector = {
  kind: 'host'
  raw: string
  hostSessionId: string
}

export type HrcRuntimeSelector = {
  kind: 'runtime'
  raw: string
  runtimeId: string
}

export type HrcMessageSelector = {
  kind: 'message'
  raw: string
  messageId: string
}

export type HrcMessageSeqSelector = {
  kind: 'message-seq'
  raw: string
  messageSeq: number
}

export type HrcMonitorSelector =
  | HrcTargetSelector
  | HrcScopeSelector
  | HrcSessionSelector
  | HrcHostSelector
  | HrcRuntimeSelector
  | HrcMessageSelector
  | HrcMessageSeqSelector

export type HrcSelector = HrcStableSelector | HrcConcreteSelector | HrcMonitorSelector

type SessionRefParts = {
  scopeRef: string
  laneRef: string
}

type CanonicalScopeRefInput = {
  scopeRef?: string | undefined
  agentId?: string | undefined
  projectId?: string | undefined
  taskId?: string | undefined
  roleName?: string | undefined
}

type CanonicalSessionRefInput = {
  scopeRef: string
  laneId?: string | undefined
  laneRef?: string | undefined
}

function invalidMonitorSelector(kind: string, position: number, reason: string): never {
  throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, reason, {
    kind,
    position,
    reason,
  })
}

function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, `${fieldName} must be a string`, {
      fieldName,
      valueType: typeof value,
    })
  }

  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, `${fieldName} must not be empty`, {
      fieldName,
    })
  }

  return normalized
}

function assertNonEmptySelectorValue(value: string, kind: string, position: number): string {
  if (value.length === 0) {
    invalidMonitorSelector(kind, position, `${kind} selector value must not be empty`)
  }
  return value
}

function normalizeLaneId(laneId?: string | undefined): string {
  if (laneId === undefined || laneId === 'main') {
    return 'main'
  }

  const laneRef = laneId.startsWith('lane:') ? laneId : `lane:${laneId}`
  const validation = validateLaneRef(laneRef)
  if (!validation.ok) {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, validation.error)
  }

  return laneRef.slice('lane:'.length)
}

function scopeHandleFor(scopeRef: string): string {
  return formatScopeHandle(parseScopeRef(scopeRef))
}

function sessionHandleFor(scopeRef: string, laneId: string): string {
  return formatSessionHandle({
    scopeRef,
    laneRef: laneId === 'main' ? 'main' : `lane:${laneId}`,
  })
}

export function splitSessionRef(sessionRef: string): SessionRefParts {
  const [scopeRef, laneSuffix, ...rest] = sessionRef.split('/')
  if (
    scopeRef === undefined ||
    rest.length > 0 ||
    laneSuffix === undefined ||
    !laneSuffix.startsWith('lane:')
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      'sessionRef must use "<scopeRef>/lane:<laneRef>" format',
      { sessionRef }
    )
  }

  const normalizedScopeRef = scopeRef.trim()
  const normalizedLaneRef = laneSuffix.trim()
  const laneId = normalizedLaneRef.slice('lane:'.length)

  if (normalizedScopeRef.length === 0 || laneId.length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      'sessionRef must include non-empty scopeRef and laneRef values',
      { sessionRef }
    )
  }

  const scopeValidation = validateScopeRef(normalizedScopeRef)
  if (!scopeValidation.ok) {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      `sessionRef must include a canonical agent ScopeRef: ${scopeValidation.error}`,
      { sessionRef, scopeRef: normalizedScopeRef }
    )
  }

  return {
    scopeRef: normalizedScopeRef,
    laneRef: laneId,
  }
}

export function normalizeSessionRef(sessionRef: string): HrcSessionRef {
  const normalized = assertNonEmptyString(sessionRef, 'sessionRef')
  const parts = splitSessionRef(normalized)
  return `${parts.scopeRef}/lane:${parts.laneRef}`
}

export function formatCanonicalScopeRef(input: CanonicalScopeRefInput): string {
  if (input.scopeRef !== undefined) {
    const normalized = assertNonEmptyString(input.scopeRef, 'scopeRef')
    const validation = validateScopeRef(normalized)
    if (!validation.ok) {
      throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, validation.error)
    }
    return normalized
  }

  const agentId = assertNonEmptyString(input.agentId, 'agentId')
  let scopeRef = `agent:${agentId}`

  if (input.projectId !== undefined) {
    scopeRef += `:project:${assertNonEmptyString(input.projectId, 'projectId')}`
  }

  if (input.taskId !== undefined) {
    scopeRef += `:task:${assertNonEmptyString(input.taskId, 'taskId')}`
  }

  if (input.roleName !== undefined) {
    scopeRef += `:role:${assertNonEmptyString(input.roleName, 'roleName')}`
  }

  const validation = validateScopeRef(scopeRef)
  if (!validation.ok) {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, validation.error)
  }

  return scopeRef
}

export function formatCanonicalSessionRef(input: CanonicalSessionRefInput): HrcSessionRef {
  const scopeRef = formatCanonicalScopeRef({ scopeRef: input.scopeRef })
  const laneId = normalizeLaneId(input.laneId ?? input.laneRef)
  return `${scopeRef}/lane:${laneId}`
}

function parseScopeMonitorSelector(
  raw: string,
  value: string,
  valuePosition: number
): HrcScopeSelector {
  const scopeRef = assertNonEmptySelectorValue(value, 'scope', valuePosition)
  const validation = validateScopeRef(scopeRef)
  if (!validation.ok) {
    invalidMonitorSelector('scope', valuePosition, validation.error)
  }

  return {
    kind: 'scope',
    raw,
    scopeRef,
    scopeHandle: scopeHandleFor(scopeRef),
  }
}

function parseSessionMonitorSelector(
  raw: string,
  value: string,
  valuePosition: number
): HrcSessionSelector {
  const sessionRefInput = assertNonEmptySelectorValue(value, 'session', valuePosition)
  let sessionRef: HrcSessionRef
  let parts: SessionRefParts

  try {
    sessionRef = normalizeSessionRef(sessionRefInput)
    parts = splitSessionRef(sessionRef)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid session selector'
    invalidMonitorSelector('session', valuePosition, reason)
  }

  return {
    kind: 'session',
    raw,
    scopeRef: parts.scopeRef,
    sessionRef,
    scopeHandle: scopeHandleFor(parts.scopeRef),
    sessionHandle: sessionHandleFor(parts.scopeRef, parts.laneRef),
  }
}

function parseTargetMonitorSelector(raw: string): HrcTargetSelector {
  let parsed: ReturnType<typeof parseSessionHandle>
  try {
    parsed = parseSessionHandle(raw)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid target selector'
    invalidMonitorSelector('target', 0, reason)
  }

  let sessionRef: HrcSessionRef
  try {
    sessionRef = formatCanonicalSessionRef({
      scopeRef: parsed.scopeRef,
      laneRef: parsed.laneRef,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid target selector'
    invalidMonitorSelector('target', 0, reason)
  }

  const { scopeRef, laneRef } = splitSessionRef(sessionRef)

  return {
    kind: 'target',
    raw,
    scopeRef,
    sessionRef,
    scopeHandle: scopeHandleFor(scopeRef),
    sessionHandle: sessionHandleFor(scopeRef, laneRef),
  }
}

function parsePrefixedMonitorSelector(
  raw: string,
  prefix: string,
  value: string
): HrcMonitorSelector {
  const valuePosition = prefix.length + 1

  switch (prefix) {
    case 'scope':
      return parseScopeMonitorSelector(raw, value, valuePosition)
    case 'session':
      return parseSessionMonitorSelector(raw, value, valuePosition)
    case 'host':
      return {
        kind: 'host',
        raw,
        hostSessionId: assertNonEmptySelectorValue(value, 'host', valuePosition),
      }
    case 'runtime':
      return {
        kind: 'runtime',
        raw,
        runtimeId: assertNonEmptySelectorValue(value, 'runtime', valuePosition),
      }
    case 'msg':
      return {
        kind: 'message',
        raw,
        messageId: assertNonEmptySelectorValue(value, 'message', valuePosition),
      }
    case 'seq': {
      const seqValue = assertNonEmptySelectorValue(value, 'message-seq', valuePosition)
      if (!/^[0-9]+$/.test(seqValue)) {
        invalidMonitorSelector('message-seq', valuePosition, 'message sequence must be an integer')
      }
      const messageSeq = Number(seqValue)
      if (!Number.isSafeInteger(messageSeq)) {
        invalidMonitorSelector('message-seq', valuePosition, 'message sequence is too large')
      }
      return {
        kind: 'message-seq',
        raw,
        messageSeq,
      }
    }
    default:
      invalidMonitorSelector('selector', 0, `unknown selector prefix "${prefix}"`)
  }
}

function parseMonitorSelector(input: string): HrcMonitorSelector {
  const raw = input.trim()
  if (raw.length === 0) {
    invalidMonitorSelector('selector', 0, 'selector must not be empty')
  }

  const colonPosition = raw.indexOf(':')
  const atPosition = raw.indexOf('@')

  if (colonPosition !== -1 && (atPosition === -1 || colonPosition < atPosition)) {
    const prefix = raw.slice(0, colonPosition)
    const value = raw.slice(colonPosition + 1)
    return parsePrefixedMonitorSelector(raw, prefix, value)
  }

  return parseTargetMonitorSelector(raw)
}

export function formatSelector(selector: HrcSelector): string {
  switch (selector.kind) {
    case 'stable':
      return `session:${selector.sessionRef}`
    case 'concrete':
      return `host:${selector.hostSessionId}`
    case 'target':
    case 'session':
      return `session:${selector.sessionRef}`
    case 'scope':
      return `scope:${selector.scopeRef}`
    case 'host':
      return `host:${selector.hostSessionId}`
    case 'runtime':
      return `runtime:${selector.runtimeId}`
    case 'message':
      return `msg:${selector.messageId}`
    case 'message-seq':
      return `seq:${selector.messageSeq}`
  }
}

export function parseSelector(input: unknown): HrcSelector {
  if (typeof input === 'string') {
    return parseMonitorSelector(input)
  }

  if (input === null || typeof input !== 'object') {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, 'selector must be an object', {
      inputType: input === null ? 'null' : typeof input,
    })
  }

  const rawSelector = input as Record<string, unknown>
  const hasSessionRef = Object.hasOwn(rawSelector, 'sessionRef')
  const hasHostSessionId = Object.hasOwn(rawSelector, 'hostSessionId')

  if (hasSessionRef === hasHostSessionId) {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      'selector must include exactly one of sessionRef or hostSessionId'
    )
  }

  if (hasSessionRef) {
    return {
      kind: 'stable',
      sessionRef: normalizeSessionRef(
        assertNonEmptyString(rawSelector['sessionRef'], 'sessionRef')
      ),
    }
  }

  return {
    kind: 'concrete',
    hostSessionId: assertNonEmptyString(rawSelector['hostSessionId'], 'hostSessionId'),
  }
}

export function isStableSelector(selector: HrcSelector): selector is HrcStableSelector {
  return selector.kind === 'stable'
}

export function isConcreteSelector(selector: HrcSelector): selector is HrcConcreteSelector {
  return selector.kind === 'concrete'
}
