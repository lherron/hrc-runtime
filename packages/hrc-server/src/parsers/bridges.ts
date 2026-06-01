import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  BindSurfaceRequest,
  CloseBridgeRequest,
  DeliverBridgeRequest,
  UnbindSurfaceRequest,
} from 'hrc-core'

import {
  isRecord,
  parseOptionalNonNegativeInteger,
  readBooleanField,
  readOptionalNonEmptyStringField,
  readOptionalStringField,
  requireStringField,
  requireTrimmedStringField,
} from './common.js'

export type BridgeSelector =
  | { sessionRef: string }
  | { hostSessionId: string }
  | { appSession: { appId: string; appSessionKey: string } }

export type BridgeTargetRequest = {
  hostSessionId?: string | undefined
  bridge?: string | undefined
  transport?: string | undefined
  target?: string | undefined
  runtimeId?: string | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  selector?: BridgeSelector | undefined
}

export type DeliverTextRequest = {
  bridgeId: string
  text: string
  enter: boolean
  oobSuffix?: string | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

export function parseBindSurfaceRequest(input: unknown): BindSurfaceRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const surfaceKind = requireTrimmedStringField(input, 'surfaceKind')
  const surfaceId = requireTrimmedStringField(input, 'surfaceId')
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
    runtimeId,
    hostSessionId,
    generation,
    ...readOptionalStringField(input, 'windowId'),
    ...readOptionalStringField(input, 'tabId'),
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

export function parseBridgeTargetRequest(input: unknown): BridgeTargetRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const expectedGeneration = parseOptionalNonNegativeInteger(input['expectedGeneration'])
  const hostSessionId = readOptionalNonEmptyStringField(input, 'hostSessionId')
  const bridge = readOptionalNonEmptyStringField(input, 'bridge')
  const transport = readOptionalNonEmptyStringField(input, 'transport')
  const target = readOptionalNonEmptyStringField(input, 'target')
  const selector = Object.hasOwn(input, 'selector')
    ? parseBridgeSelector(input['selector'])
    : undefined
  const hasExplicitBinding = transport !== undefined || target !== undefined

  if (hasExplicitBinding && (transport === undefined || target === undefined)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'transport and target must be provided together'
    )
  }
  if (!hasExplicitBinding && (selector === undefined || bridge === undefined)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'transport and target are required unless selector and bridge are provided'
    )
  }

  return {
    ...(hostSessionId !== undefined ? { hostSessionId } : {}),
    ...(bridge !== undefined ? { bridge } : {}),
    ...(transport !== undefined ? { transport } : {}),
    ...(target !== undefined ? { target } : {}),
    ...readOptionalStringField(input, 'runtimeId'),
    ...readOptionalStringField(input, 'expectedHostSessionId'),
    ...(selector !== undefined ? { selector } : {}),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  }
}

export function parseDeliverBridgeRequest(input: unknown): DeliverBridgeRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const expectedGeneration = parseOptionalNonNegativeInteger(input['expectedGeneration'])

  return {
    bridgeId: requireTrimmedStringField(input, 'bridgeId'),
    text: requireStringField(input, 'text'),
    ...readOptionalStringField(input, 'expectedHostSessionId'),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  }
}

export function parseDeliverTextRequest(input: unknown): DeliverTextRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const expectedGeneration = parseOptionalNonNegativeInteger(input['expectedGeneration'])

  return {
    bridgeId: requireTrimmedStringField(input, 'bridgeId'),
    text: requireStringField(input, 'text'),
    enter: readBooleanField(input, 'enter'),
    ...(typeof input['oobSuffix'] === 'string' ? { oobSuffix: input['oobSuffix'] } : {}),
    ...readOptionalStringField(input, 'expectedHostSessionId'),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  }
}

export function parseCloseBridgeRequest(input: unknown): CloseBridgeRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  return {
    bridgeId: requireTrimmedStringField(input, 'bridgeId'),
  }
}

export function parseBridgeSelector(input: unknown): BridgeSelector {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, 'selector must be an object')
  }

  const hasSessionRef = Object.hasOwn(input, 'sessionRef')
  const hasHostSessionId = Object.hasOwn(input, 'hostSessionId')
  const hasAppSession = Object.hasOwn(input, 'appSession')
  const variantCount = Number(hasSessionRef) + Number(hasHostSessionId) + Number(hasAppSession)

  if (variantCount !== 1) {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      'selector must include exactly one of sessionRef, hostSessionId, or appSession'
    )
  }

  if (hasSessionRef) {
    return {
      sessionRef: requireTrimmedStringField(input, 'sessionRef'),
    }
  }

  if (hasHostSessionId) {
    return {
      hostSessionId: requireTrimmedStringField(input, 'hostSessionId'),
    }
  }

  const appSession = input['appSession']
  if (!isRecord(appSession)) {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, 'appSession must be an object')
  }

  return {
    appSession: {
      appId: requireTrimmedStringField(appSession, 'appId'),
      appSessionKey: requireTrimmedStringField(appSession, 'appSessionKey'),
    },
  }
}
