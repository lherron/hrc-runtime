import type {
  InvocationEventEnvelope,
  InvocationFailedPayload,
} from 'spaces-harness-broker-protocol'

/**
 * Codex reports its native `willRetry` bit through the broker protocol's
 * normalized `InvocationFailedPayload.retryable` field. Such an envelope is
 * attempt evidence, not the invocation's terminal outcome: the harness remains
 * authoritative until it emits a later exhausted/non-retryable failure.
 */
export function isRetryableInvocationFailure(envelope: InvocationEventEnvelope): boolean {
  return (
    envelope.type === 'invocation.failed' &&
    (envelope.payload as InvocationFailedPayload).retryable === true
  )
}
