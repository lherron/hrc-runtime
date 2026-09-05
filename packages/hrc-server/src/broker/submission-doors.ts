import type {
  InvocationResponseFormat,
  SubmissionOrigin,
  SubmissionResponse,
  TurnPolicy,
} from 'spaces-harness-broker-protocol'

import type { HarnessBrokerController } from './controller.js'

export type HrcBrokerSubmissionDoor = 'steer' | 'enqueue' | 'invoke' | 'preempt'

export type HrcBrokerSubmissionInput = {
  runtimeId: string
  runId?: string | undefined
  body: string
  origin: SubmissionOrigin
  responseFormat?: InvocationResponseFormat | undefined
  freshContext?: boolean | undefined
  ttlMs?: number | undefined
  turnPolicy?: TurnPolicy | undefined
}

export function submitThroughBrokerDoor(
  controller: HarnessBrokerController,
  door: HrcBrokerSubmissionDoor,
  input: HrcBrokerSubmissionInput
) {
  const common = {
    runtimeId: input.runtimeId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    submissionDoor: door,
    body: input.body,
    origin: input.origin,
    ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
    ...(input.freshContext !== undefined ? { freshContext: input.freshContext } : {}),
  }
  switch (door) {
    case 'steer':
      return controller.steer(common)
    case 'enqueue':
      return controller.enqueue({
        ...common,
        ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
        ...(input.turnPolicy !== undefined ? { turnPolicy: input.turnPolicy } : {}),
      })
    case 'invoke':
      return controller.invoke({
        ...common,
        ...(input.turnPolicy !== undefined ? { turnPolicy: input.turnPolicy } : {}),
      })
    case 'preempt':
      return controller.preempt({
        ...common,
        ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
        ...(input.turnPolicy !== undefined ? { turnPolicy: input.turnPolicy } : {}),
      })
  }
}

export function submissionOrigin(
  scopeRef: string,
  input: {
    submissionOrigin?: SubmissionOrigin | undefined
    origin?: { actor?: string | undefined } | undefined
  }
): SubmissionOrigin {
  return (
    input.submissionOrigin ?? {
      principalRef: input.origin?.actor ?? 'system:hrc',
      scopeRef,
    }
  )
}

export type BrokerDoorResult = Awaited<ReturnType<typeof submitThroughBrokerDoor>>
export type BrokerDoorResponse = SubmissionResponse
