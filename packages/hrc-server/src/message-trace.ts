import type {
  HrcCollectiveMessageRecord,
  HrcMessageDeliveryEvidence,
  HrcMessageHistoryStatus,
  HrcMessageRecord,
  HrcMessageTraceDestination,
  HrcMessageTraceVerdict,
  TraceMessageResponse,
} from 'hrc-core'

function deliveryEvidence(record: HrcMessageRecord): HrcMessageDeliveryEvidence | undefined {
  const value = record.metadataJson?.['federationDelivery']
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const outcome = (value as Record<string, unknown>)['outcome']
  const observedAt = (value as Record<string, unknown>)['observedAt']
  if (
    (outcome !== 'runtime_delivery' && outcome !== 'store_only') ||
    typeof observedAt !== 'string'
  ) {
    return undefined
  }
  if (outcome === 'runtime_delivery') return { outcome, observedAt }
  const reason = (value as Record<string, unknown>)['reason']
  return typeof reason === 'string' ? { outcome, reason, observedAt } : undefined
}

function destinationObservation(
  message: HrcCollectiveMessageRecord,
  localRecord: HrcMessageRecord | undefined,
  localNodeId: string
): HrcMessageTraceDestination | undefined {
  const observations = message.collectiveHistory?.observations ?? []
  const destination = observations.find((observation) => observation.role === 'destination')
  if (destination !== undefined) {
    return {
      nodeId: destination.nodeId,
      messageId: message.messageId,
      messageSeq: destination.messageSeq,
      observedAt: destination.observedAt,
      execution: destination.execution,
      ...(destination.delivery === undefined ? {} : { delivery: destination.delivery }),
    }
  }

  const ingress = localRecord?.metadataJson?.['federationIngress']
  if (localRecord === undefined || ingress === null || typeof ingress !== 'object') {
    return undefined
  }
  const parsedDelivery = deliveryEvidence(localRecord)
  return {
    nodeId: localNodeId,
    messageId: localRecord.messageId,
    messageSeq: localRecord.messageSeq,
    observedAt: parsedDelivery === undefined ? localRecord.createdAt : parsedDelivery.observedAt,
    execution: localRecord.execution,
    ...(parsedDelivery === undefined
      ? {}
      : {
          delivery: parsedDelivery,
        }),
  }
}

function traceVerdict(input: {
  localNodeId: string
  message: HrcCollectiveMessageRecord
  localRecord?: HrcMessageRecord | undefined
  destination?: HrcMessageTraceDestination | undefined
  history: HrcMessageHistoryStatus
}): HrcMessageTraceVerdict {
  const { destination } = input
  if (destination?.delivery?.outcome === 'store_only') {
    return {
      code: 'stored_not_injected',
      summary: `stored on ${destination.nodeId}, NOT injected (${destination.delivery.reason})`,
    }
  }
  const runtimeId = destination?.execution.runtimeId
  if (
    destination?.delivery?.outcome === 'runtime_delivery' &&
    destination.execution.state === 'failed'
  ) {
    return {
      code: 'runtime_delivery_failed',
      summary: `runtime delivery failed on ${destination.nodeId}: ${
        destination.execution.errorCode ?? 'unknown_error'
      }`,
    }
  }
  if (
    runtimeId !== undefined &&
    (destination?.delivery?.outcome === 'runtime_delivery' ||
      destination?.execution.state === 'started' ||
      destination?.execution.state === 'completed')
  ) {
    return {
      code: 'delivered_to_runtime',
      summary: `delivered to runtime ${runtimeId} on ${destination.nodeId}`,
    }
  }
  if (destination !== undefined) {
    return {
      code: 'accepted_delivery_pending',
      summary: `accepted by ${destination.nodeId}; runtime delivery evidence pending`,
    }
  }
  if (!input.history.complete) {
    return {
      code: 'history_incomplete',
      summary: `message found, but authoritative history is incomplete (${input.history.degraded?.code ?? 'collective_lagging'})`,
    }
  }
  return {
    code: 'local_message',
    summary: `local message #${input.localRecord?.messageSeq ?? input.message.messageSeq} on ${input.localNodeId} (${input.localRecord?.execution.state ?? input.message.execution.state})`,
  }
}

export function buildMessageTrace(input: {
  localNodeId: string
  message: HrcCollectiveMessageRecord
  localRecord?: HrcMessageRecord | undefined
  history: HrcMessageHistoryStatus
}): TraceMessageResponse {
  const destination = destinationObservation(input.message, input.localRecord, input.localNodeId)
  return {
    localNodeId: input.localNodeId,
    message: input.message,
    ...(input.localRecord === undefined ? {} : { localRecord: input.localRecord }),
    ...(destination === undefined ? {} : { destination }),
    history: input.history,
    verdict: traceVerdict({ ...input, destination }),
  }
}
