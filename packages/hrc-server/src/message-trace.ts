import type {
  FederationOutboxDeliveryRecord,
  HrcCollectiveMessageRecord,
  HrcMessageDeliveryEvidence,
  HrcMessageHistoryStatus,
  HrcMessageRecord,
  HrcMessageTraceAcceptance,
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
  localNodeId: string,
  outbox: FederationOutboxDeliveryRecord | undefined
): HrcMessageTraceDestination | undefined {
  const observations = message.collectiveHistory?.observations ?? []
  const destination =
    observations.find(
      (observation) =>
        observation.role === 'destination' && observation.nodeId === outbox?.peerNodeId
    ) ?? observations.find((observation) => observation.role === 'destination')
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
  outbox?: FederationOutboxDeliveryRecord | undefined
  destination?: HrcMessageTraceDestination | undefined
  history: HrcMessageHistoryStatus
}): HrcMessageTraceVerdict {
  const { destination, outbox } = input
  if (outbox?.state === 'dead_letter') {
    const error = outbox.lastError?.code ?? outbox.lastErrorCode ?? 'delivery_failed'
    return {
      code: 'outbox_dead_letter',
      summary: `dead-lettered in origin outbox: ${error} x${outbox.totalAttempts}`,
    }
  }
  if (
    outbox !== undefined &&
    (outbox.state === 'pending' ||
      outbox.state === 'retry_scheduled' ||
      outbox.state === 'peer_unreachable')
  ) {
    const error = outbox.lastError?.code ?? outbox.lastErrorCode
    return {
      code: 'outbox_pending',
      summary:
        error === undefined
          ? `queued in origin outbox for ${outbox.peerNodeId} (${outbox.totalAttempts} attempts)`
          : `jammed in origin outbox: ${error} x${outbox.totalAttempts}`,
    }
  }
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
  if (destination !== undefined || outbox?.state === 'delivered') {
    return {
      code: 'accepted_delivery_pending',
      summary: `accepted by ${destination?.nodeId ?? outbox?.peerNodeId ?? 'peer'}; runtime delivery evidence pending`,
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
  outbox?: FederationOutboxDeliveryRecord | undefined
  acceptance?: HrcMessageTraceAcceptance | undefined
  history: HrcMessageHistoryStatus
}): TraceMessageResponse {
  const destination = destinationObservation(
    input.message,
    input.localRecord,
    input.localNodeId,
    input.outbox
  )
  return {
    localNodeId: input.localNodeId,
    message: input.message,
    ...(input.localRecord === undefined ? {} : { localRecord: input.localRecord }),
    ...(input.outbox === undefined ? {} : { outbox: input.outbox }),
    ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
    ...(destination === undefined ? {} : { destination }),
    history: input.history,
    verdict: traceVerdict({ ...input, destination }),
  }
}
