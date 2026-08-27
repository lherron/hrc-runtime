import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  PruneRuntimesRequest,
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

export function parsePruneRuntimesRequest(input: unknown): PruneRuntimesRequest {
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
      {
        field: 'scope',
      }
    )
  }

  const runtimeIds = input['runtimeIds']
  if (runtimeIds !== undefined && !Array.isArray(runtimeIds)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeIds must be an array', {
      field: 'runtimeIds',
    })
  }
  const parsedRuntimeIds = runtimeIds?.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `runtimeIds[${index}] must be a non-empty string`,
        { field: `runtimeIds[${index}]` }
      )
    }
    return entry.trim()
  })
  if (parsedRuntimeIds?.length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeIds must not be empty', {
      field: 'runtimeIds',
    })
  }
  if (parsedRuntimeIds && new Set(parsedRuntimeIds).size !== parsedRuntimeIds.length) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIds must not contain duplicates',
      { field: 'runtimeIds' }
    )
  }

  const dryRun = readOptionalBooleanField(input, 'dryRun')
  const yes = readOptionalBooleanField(input, 'yes')
  const includeLedgers = readOptionalBooleanField(input, 'includeLedgers')

  if ((parsedRuntimeIds !== undefined) !== (includeLedgers === true)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIds and includeLedgers:true must be supplied together',
      { fields: ['runtimeIds', 'includeLedgers'] }
    )
  }
  if (
    parsedRuntimeIds !== undefined &&
    (transport !== undefined ||
      olderThan !== undefined ||
      parsedStatus !== undefined ||
      scope !== undefined)
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIds manifest mode does not accept transport, olderThan, status, or scope filters',
      { field: 'runtimeIds' }
    )
  }

  return {
    ...(transport ? { transport: transport as SweepRuntimeTransport } : {}),
    ...(olderThan ? { olderThan: olderThan.trim() } : {}),
    ...(parsedStatus ? { status: parsedStatus } : {}),
    ...(scope ? { scope: scope.trim() } : {}),
    ...(parsedRuntimeIds ? { runtimeIds: parsedRuntimeIds } : {}),
    ...(includeLedgers === true ? { includeLedgers: true } : {}),
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
