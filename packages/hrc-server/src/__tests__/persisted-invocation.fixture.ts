import type { HrcExecutionFormat } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

/**
 * Persist the broker invocation a dispatch double claims to have started.
 *
 * Since T-08207 (bb418a48) a broker-backed submission receipt echoes the
 * execution format HRC froze for that exact invocation, and fails closed with
 * 503 `execution_format_unproved` when the named invocation has no row. A
 * double that answers `startIdentity: { kind: 'broker', invocationId }` must
 * therefore stand on a real row, exactly as a live dispatch does.
 */
export function seedDispatchedBrokerInvocation(
  db: HrcDatabase,
  input: { invocationId: string; runtimeId: string; executionFormat?: HrcExecutionFormat }
): void {
  const now = new Date().toISOString()
  db.brokerInvocations.insert({
    invocationId: input.invocationId,
    operationId: `op-${input.invocationId}`,
    runtimeId: input.runtimeId,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'claude-code-tmux',
    invocationState: 'ready',
    capabilitiesJson: JSON.stringify({ input: { queue: true } }),
    specHash: `sha256:spec-${input.invocationId}`,
    startRequestHash: `sha256:req-${input.invocationId}`,
    selectedProfileHash: `sha256:profile-${input.invocationId}`,
    ...(input.executionFormat !== undefined ? { executionFormat: input.executionFormat } : {}),
    createdAt: now,
    updatedAt: now,
  })
}
