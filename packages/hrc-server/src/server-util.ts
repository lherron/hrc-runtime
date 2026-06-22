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

export function encodeNdjson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`)
}

export function serializeEvent(event: HrcLifecycleEvent): string {
  return `${JSON.stringify(event)}\n`
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HrcDomainError) {
    return Response.json(error.toResponse(), { status: error.status })
  }

  const internal = toInternalError(error)
  return Response.json(internal, {
    status: httpStatusForErrorCode(internal.error.code),
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

export function createHostSessionId(): string {
  return `hsid-${randomUUID()}`
}

export function timestamp(): string {
  return new Date().toISOString()
}

export function isRuntimeUnavailableStatus(status: string): boolean {
  return status === 'terminated' || status === 'dead' || status === 'stale'
}

export async function unlinkIfExists(path: string): Promise<void> {
  await rm(path, { force: true })
}
