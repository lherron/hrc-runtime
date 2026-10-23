import type { HrcRuntimeSnapshot } from 'hrc-core'

import { appendHrcEvent } from './hrc-event-helper.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'
import { settleTerminalRuntimeRuns } from './terminal-runtime-runs.js'

/**
 * The only behavioral discriminator for an externally-owned runtime.
 *
 * Legacy harness/provider columns and broker substrate metadata are projections;
 * neither may grant HRC process-lifecycle authority.
 */
export function isExternalLifecycleOwner(runtime: HrcRuntimeSnapshot): boolean {
  return runtime.runtimeStateJson?.['lifecycleOwner'] === 'external'
}

/**
 * Operator eviction for an externally-owned runtime.
 *
 * This intentionally performs only HRC-owned effects: finalize durable state
 * and emit the audit event. It never invokes a broker lifecycle RPC, signals a
 * process, tears down terminal substrate, drops continuation state, or mutates
 * placement authority.
 */
export async function evictExternalParticipant(
  server: HrcServerInstanceForHandlers,
  snapshot: HrcRuntimeSnapshot
): Promise<void> {
  const runtime = server.db.runtimes.getByRuntimeId(snapshot.runtimeId) ?? snapshot
  if (!isExternalLifecycleOwner(runtime)) return

  const invocationId = runtime.activeInvocationId
  const now = timestamp()

  if (runtime.status !== 'terminated' || runtime.lifecycleTerminalReason !== 'operator_evict') {
    if (invocationId !== undefined) {
      const invocation = server.db.brokerInvocations.getByInvocationId(invocationId)
      if (invocation !== null) {
        server.db.brokerInvocations.update(invocationId, {
          invocationState: 'disposed',
          lifecycleTerminalReason: 'operator_evict',
          updatedAt: now,
        })
      }
    }
    server.db.sqlite.transaction(() => {
      settleTerminalRuntimeRuns(server.db, runtime.runtimeId, {
        now,
        errorMessage: `runtime ${runtime.runtimeId} was evicted by operator: operator_evict`,
      })
      server.db.runtimes.update(runtime.runtimeId, {
        status: 'terminated',
        statusChangedAt: now,
        lifecycleTerminalReason: 'operator_evict',
        ...runtimeActivityPatch(server.db, runtime.runtimeId, {
          source: 'housekeeping',
          updatedAt: now,
        }),
        runtimeStateJson: {
          ...(runtime.runtimeStateJson ?? {}),
          status: 'terminated',
          updatedAt: now,
          terminalReason: 'operator_evict',
        },
      })
    })()
    const event = appendHrcEvent(server.db, 'runtime.terminated', {
      ts: now,
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      payload: {
        reason: 'operator_evict',
        droppedContinuation: false,
        ...(invocationId === undefined ? {} : { invocationId }),
      },
    })
    server.ctx.notifyEvent(event)
  }
}
