import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type { BindSurfaceRequest, UnbindSurfaceRequest } from 'hrc-core'

import {
  isRecord,
  readOptionalNonEmptyStringField,
  readOptionalStringField,
  requireTrimmedStringField,
} from './common.js'

export function parseBindSurfaceRequest(input: unknown): BindSurfaceRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const surfaceKind = requireTrimmedStringField(input, 'surfaceKind')
  const surfaceId = requireTrimmedStringField(input, 'surfaceId')
  const clientTty = readOptionalNonEmptyStringField(input, 'clientTty')
  const runtimeId = requireTrimmedStringField(input, 'runtimeId')
  const hostSessionId = requireTrimmedStringField(input, 'hostSessionId')
  const generation = input['generation']
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'generation is required', {
      field: 'generation',
    })
  }

  return {
    surfaceKind,
    surfaceId,
    ...(clientTty !== undefined ? { clientTty } : {}),
    runtimeId,
    hostSessionId,
    generation,
    ...readOptionalStringField(input, 'windowId'),
    ...readOptionalStringField(input, 'paneId'),
  }
}

export function parseUnbindSurfaceRequest(input: unknown): UnbindSurfaceRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  return {
    surfaceKind: requireTrimmedStringField(input, 'surfaceKind'),
    surfaceId: requireTrimmedStringField(input, 'surfaceId'),
    ...readOptionalStringField(input, 'reason'),
  }
}
