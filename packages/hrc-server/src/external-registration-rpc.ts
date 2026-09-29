import {
  EPR_REPLAY_UNAVAILABLE_CODE,
  type ExternalParticipantRpcClient,
} from './external-registration-protocol.js'

export class EprReplayGapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EprReplayGapError'
  }
}

export function rpcErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

type EprRpcFailureMetadata = {
  rpcMethod?: string | undefined
  failureCode?: string | undefined
}

class EprRpcDeadlineError extends Error {
  constructor(label: string, deadlineMs: number) {
    super(`${label} timed out after ${deadlineMs}ms`)
    this.name = 'EprRpcDeadlineError'
  }
}

export function annotateRpcError(
  error: unknown,
  method: string,
  failureCode = 'transport_error'
): Error & EprRpcFailureMetadata {
  const normalized = error instanceof Error ? error : new Error(String(error))
  const annotated = normalized as Error & EprRpcFailureMetadata
  annotated.rpcMethod = method
  annotated.failureCode = failureCode
  return annotated
}

export function rpcFailureMethod(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const method = (error as EprRpcFailureMetadata).rpcMethod
  return typeof method === 'string' ? method : undefined
}

export function rpcFailureCode(error: unknown): number | string {
  const code = rpcErrorCode(error)
  if (code !== undefined) return code
  if (typeof error === 'object' && error !== null) {
    const failureCode = (error as EprRpcFailureMetadata).failureCode
    if (typeof failureCode === 'string') return failureCode
  }
  return 'internal_error'
}

export async function requestExternalParticipantRpc(
  client: ExternalParticipantRpcClient,
  method: string,
  params: Record<string, unknown>,
  deadlineMs: number
): Promise<unknown> {
  try {
    return await withDeadline(client.request(method, params), deadlineMs, method)
  } catch (error) {
    throw annotateRpcError(
      error,
      method,
      error instanceof EprRpcDeadlineError ? 'deadline_exceeded' : 'transport_error'
    )
  }
}

export async function requestReplayPlane(
  client: ExternalParticipantRpcClient,
  method: 'epr.reattach' | 'invocation.snapshot' | 'invocation.eventsSince',
  params: Record<string, unknown>,
  deadlineMs: number
): Promise<unknown> {
  try {
    return await requestExternalParticipantRpc(client, method, params, deadlineMs)
  } catch (error) {
    if (rpcErrorCode(error) === EPR_REPLAY_UNAVAILABLE_CODE) {
      throw new EprReplayGapError(`${method} reported that event replay is unavailable`)
    }
    throw error
  }
}

async function withDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new EprRpcDeadlineError(label, deadlineMs)), deadlineMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
