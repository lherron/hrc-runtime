/**
 * Reattach control-proof helpers for `attachAndReplay()` — proves a reattached
 * broker still answers health/status before its runtime is trusted.
 */

import type { HrcBrokerInvocationRecord, HrcRuntimeSnapshot } from 'hrc-core'
import type {
  BrokerHealthResponse,
  InvocationId,
  InvocationStatusResponse,
} from 'spaces-harness-broker-protocol'
import type { DispatchContext } from './dispatch-context'
import { BrokerControllerError } from './errors'
import type { BrokerControllerAttachInput } from './types'

export function brokerControlProbeErrorDetail(error: unknown): Record<string, unknown> {
  if (error instanceof BrokerControllerError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      detail: error.detail,
    }
  }
  if (error instanceof Error) {
    const candidate = error as Error & {
      code?: unknown
      data?: unknown
      detail?: unknown
      cause?: unknown
    }
    return {
      name: error.name,
      message: error.message,
      ...(candidate.code !== undefined ? { code: candidate.code } : {}),
      ...(candidate.data !== undefined ? { data: candidate.data } : {}),
      ...(candidate.detail !== undefined ? { detail: candidate.detail } : {}),
      ...(candidate.cause instanceof Error
        ? {
            cause: {
              name: candidate.cause.name,
              message: candidate.cause.message,
              ...((candidate.cause as Error & { code?: unknown }).code !== undefined
                ? { code: (candidate.cause as Error & { code?: unknown }).code }
                : {}),
            },
          }
        : {}),
    }
  }
  return { value: String(error) }
}

async function withAttachControlProbeTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  detail: Record<string, unknown>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new BrokerControllerError(
          'broker_control_probe_timeout',
          `broker reattach control proof timed out after ${timeoutMs}ms`,
          { ...detail, timeoutMs }
        )
      )
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

export async function proveReattachedBrokerControl(
  ctx: DispatchContext,
  input: BrokerControllerAttachInput,
  runtime: HrcRuntimeSnapshot,
  invocation: HrcBrokerInvocationRecord,
  trace: (phase: string, fields?: Record<string, unknown>) => void
): Promise<void> {
  let health: BrokerHealthResponse
  try {
    health = await withAttachControlProbeTimeout(
      input.client.health({ probeDrivers: true }),
      ctx.attachControlProbeTimeoutMs,
      {
        phase: 'health',
        runtimeId: runtime.runtimeId,
        invocationId: invocation.invocationId,
      }
    )
  } catch (error) {
    if (error instanceof BrokerControllerError) {
      throw error
    }
    throw new BrokerControllerError(
      'broker_control_probe_failed',
      `broker reattach health proof failed for ${runtime.runtimeId}`,
      {
        phase: 'health',
        runtimeId: runtime.runtimeId,
        invocationId: invocation.invocationId,
        cause: brokerControlProbeErrorDetail(error),
      }
    )
  }
  trace('control-health', { proofResult: health.status })
  if (health.status === 'shutting_down') {
    throw new BrokerControllerError(
      'broker_control_probe_shutting_down',
      `broker ${runtime.runtimeId} is shutting down during reattach control proof`,
      {
        runtimeId: runtime.runtimeId,
        invocationId: invocation.invocationId,
        healthStatus: health.status,
      }
    )
  }
  if (health.status !== 'ok' && health.status !== 'degraded') {
    throw new BrokerControllerError(
      'broker_control_probe_failed',
      `broker ${runtime.runtimeId} returned an unsupported health status during reattach`,
      {
        runtimeId: runtime.runtimeId,
        invocationId: invocation.invocationId,
        healthStatus: health.status,
      }
    )
  }

  let status: InvocationStatusResponse
  try {
    status = await withAttachControlProbeTimeout(
      input.client.status({ invocationId: invocation.invocationId as InvocationId }),
      ctx.attachControlProbeTimeoutMs,
      {
        phase: 'status',
        runtimeId: runtime.runtimeId,
        invocationId: invocation.invocationId,
      }
    )
  } catch (error) {
    if (error instanceof BrokerControllerError) {
      throw error
    }
    throw new BrokerControllerError(
      'broker_control_probe_failed',
      `broker reattach status proof failed for ${runtime.runtimeId}`,
      {
        phase: 'status',
        runtimeId: runtime.runtimeId,
        invocationId: invocation.invocationId,
        cause: brokerControlProbeErrorDetail(error),
      }
    )
  }
  trace('control-status', {
    proofResult: 'returned',
    reportedInvocationId: String(status.invocationId),
    invocationState: status.state,
  })
  if (String(status.invocationId) !== invocation.invocationId) {
    throw new BrokerControllerError(
      'broker_control_probe_invocation_mismatch',
      `broker reattach status returned invocation ${String(status.invocationId)} instead of ${invocation.invocationId}`,
      {
        runtimeId: runtime.runtimeId,
        expectedInvocationId: invocation.invocationId,
        actualInvocationId: String(status.invocationId),
      }
    )
  }
}
