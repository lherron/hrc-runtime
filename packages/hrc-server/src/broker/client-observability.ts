import { BrokerClient } from 'spaces-harness-broker-client'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { writeServerLog } from '../server-log.js'

export function droppedBrokerClientEventFields(
  event: InvocationEventEnvelope,
  lastSeq: number
): Record<string, unknown> {
  return {
    invocationId: String(event.invocationId),
    seq: event.seq,
    type: event.type,
    lastSeq,
  }
}

export function logDroppedBrokerClientEvent(event: InvocationEventEnvelope, lastSeq: number): void {
  writeServerLog(
    'WARN',
    'broker.client_dropped_backward_seq',
    droppedBrokerClientEventFields(event, lastSeq)
  )
}

export function connectObservedBrokerUnixClient(options: {
  socketPath: string
  timeoutMs?: number | undefined
}): Promise<BrokerClient> {
  return BrokerClient.connectUnix({
    ...options,
    onDroppedEvent: logDroppedBrokerClientEvent,
  })
}
