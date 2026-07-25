import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'

import {
  HrcDomainError,
  HrcErrorCode,
  HrcInternalError,
  createHrcError,
  httpStatusForErrorCode,
} from 'hrc-core'
import type { HrcHttpError, HrcLifecycleEvent } from 'hrc-core'

import { writeServerLog } from './server-log.js'

const REQUEST_CONTEXT_QUERY_KEYS = [
  'scopeRef',
  'laneRef',
  'runId',
  'runtimeId',
  'hostSessionId',
  'invocationId',
  'messageId',
] as const
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export function encodeNdjson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`)
}

export function serializeEvent(event: HrcLifecycleEvent): string {
  return `${JSON.stringify(event)}\n`
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

export function errorResponse(error: unknown, request?: Request): Response {
  if (error instanceof HrcDomainError) {
    return Response.json(error.toResponse(), { status: error.status })
  }

  const context = internalErrorRequestContext(request)
  const converted = toInternalError(error)
  const internal: HrcHttpError = {
    error: {
      ...converted.error,
      detail: {
        ...converted.error.detail,
        requestId: context.requestId,
      },
    },
  }
  writeServerLog('ERROR', 'request.unhandled_error', {
    ...context,
    errorCode: internal.error.code,
    error,
  })
  return Response.json(internal, {
    status: httpStatusForErrorCode(internal.error.code),
    headers: { 'x-hrc-request-id': context.requestId },
  })
}

export function toInternalError(error: unknown): HrcHttpError {
  if (error instanceof HrcInternalError) {
    return error.toResponse()
  }

  return createHrcError(HrcErrorCode.INTERNAL_ERROR, 'internal server error', {
    cause: error instanceof Error ? error.message : String(error),
  })
}

function internalErrorRequestContext(request?: Request): Record<string, string> & {
  requestId: string
} {
  const suppliedRequestId = request?.headers.get('x-hrc-request-id')?.trim()
  const requestId =
    suppliedRequestId && SAFE_REQUEST_ID_PATTERN.test(suppliedRequestId)
      ? suppliedRequestId
      : `req-${randomUUID()}`
  if (!request) {
    return { requestId }
  }

  const url = new URL(request.url)
  const context: Record<string, string> & { requestId: string } = {
    requestId,
    method: request.method,
    path: url.pathname,
  }
  for (const key of REQUEST_CONTEXT_QUERY_KEYS) {
    const value = url.searchParams.get(key)?.trim()
    if (value) {
      context[key] = value
    }
  }
  return context
}

export function createHostSessionId(): string {
  return `hsid-${randomUUID()}`
}

export function timestamp(): string {
  return new Date().toISOString()
}

export function isRuntimeUnavailableStatus(status: string): boolean {
  return status === 'terminated' || status === 'dead' || status === 'stale' || status === 'crashed'
}

export async function unlinkIfExists(path: string): Promise<void> {
  await rm(path, { force: true })
}
