import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'

import { isRecord } from './common.js'

export function parseResolveSessionRequest(input: unknown): { sessionRef: string } {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const sessionRef = input['sessionRef']
  if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required', {
      field: 'sessionRef',
    })
  }

  parseSessionRef(sessionRef)
  return { sessionRef: sessionRef.trim() }
}

export function parseSessionRef(sessionRef: string): { scopeRef: string; laneRef: string } {
  const normalized = sessionRef.trim()
  const parts = normalized.split('/')
  if (parts.length !== 2 || !parts[1]?.startsWith('lane:')) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'sessionRef must use "<scopeRef>/lane:<laneRef>" format',
      { sessionRef }
    )
  }

  const scopeRef = parts[0]?.trim() ?? ''
  const laneRef = parts[1].slice('lane:'.length).trim()
  if (scopeRef.length === 0 || laneRef.length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'sessionRef must include scopeRef and laneRef',
      { sessionRef }
    )
  }

  return { scopeRef, laneRef }
}
