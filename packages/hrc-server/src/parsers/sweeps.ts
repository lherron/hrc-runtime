import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  ReconcileActiveRunsRequest,
  SweepRuntimeTransport,
  SweepRuntimesRequest,
  SweepZombieRunsRequest,
} from 'hrc-core'

import { isRecord, readOptionalBooleanField, requireOptionalOneOf } from './common.js'

export function parseSweepRuntimesRequest(input: unknown): SweepRuntimesRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const transport = requireOptionalOneOf(
    input['transport'],
    ['tmux', 'headless', 'sdk'],
    'transport must be one of: tmux, headless, sdk',
    { field: 'transport' }
  )

  const status = input['status']
  if (status !== undefined && !Array.isArray(status)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'status must be an array', {
      field: 'status',
    })
  }
  const parsedStatus = status?.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `status[${index}] must be a non-empty string`,
        { field: `status[${index}]` }
      )
    }
    return entry.trim()
  })

  const olderThan = input['olderThan']
  if (olderThan !== undefined && (typeof olderThan !== 'string' || olderThan.trim().length === 0)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'olderThan must be a non-empty string',
      { field: 'olderThan' }
    )
  }

  const scope = input['scope']
  if (scope !== undefined && (typeof scope !== 'string' || scope.trim().length === 0)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'scope must be a non-empty string',
      { field: 'scope' }
    )
  }

  const dropContinuation = readOptionalBooleanField(input, 'dropContinuation')
  const dryRun = readOptionalBooleanField(input, 'dryRun')
  const yes = readOptionalBooleanField(input, 'yes')

  return {
    ...(transport ? { transport: transport as SweepRuntimeTransport } : {}),
    ...(olderThan ? { olderThan: olderThan.trim() } : {}),
    ...(parsedStatus ? { status: parsedStatus } : {}),
    ...(scope ? { scope: scope.trim() } : {}),
    ...(typeof dropContinuation === 'boolean' ? { dropContinuation } : {}),
    ...(typeof dryRun === 'boolean' ? { dryRun } : {}),
    ...(typeof yes === 'boolean' ? { yes } : {}),
  }
}

export function parseSweepZombieRunsRequest(input: unknown): SweepZombieRunsRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const olderThan = input['olderThan']
  if (olderThan !== undefined && (typeof olderThan !== 'string' || olderThan.trim().length === 0)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'olderThan must be a non-empty string',
      { field: 'olderThan' }
    )
  }

  const dryRun = readOptionalBooleanField(input, 'dryRun')
  const yes = readOptionalBooleanField(input, 'yes')

  return {
    ...(olderThan ? { olderThan: olderThan.trim() } : {}),
    ...(typeof dryRun === 'boolean' ? { dryRun } : {}),
    ...(typeof yes === 'boolean' ? { yes } : {}),
  }
}

export function parseReconcileActiveRunsRequest(input: unknown): ReconcileActiveRunsRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const olderThan = input['olderThan']
  if (olderThan !== undefined && (typeof olderThan !== 'string' || olderThan.trim().length === 0)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'olderThan must be a non-empty string',
      { field: 'olderThan' }
    )
  }

  const dryRun = readOptionalBooleanField(input, 'dryRun')
  const yes = readOptionalBooleanField(input, 'yes')

  return {
    ...(olderThan ? { olderThan: olderThan.trim() } : {}),
    ...(typeof dryRun === 'boolean' ? { dryRun } : {}),
    ...(typeof yes === 'boolean' ? { yes } : {}),
  }
}
