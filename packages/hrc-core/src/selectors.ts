import { validateScopeRef } from 'agent-scope'

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

export type HrcSelector = HrcStableSelector | HrcConcreteSelector

type SessionRefParts = {
  scopeRef: string
  laneRef: string
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

export function parseSelector(input: unknown): HrcSelector {
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
