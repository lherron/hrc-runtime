import { rm } from 'node:fs/promises'

import type { HrcRuntimeSnapshot } from 'hrc-core'

import { appendHrcEvent } from './hrc-event-helper.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'

/**
 * The only behavioral discriminator for an externally-owned runtime.
 *
 * Legacy harness/provider columns and broker substrate metadata are projections;
 * neither may grant HRC process-lifecycle authority.
 */
export function isExternalLifecycleOwner(runtime: HrcRuntimeSnapshot): boolean {
  return runtime.runtimeStateJson?.['lifecycleOwner'] === 'external'
}

function externalRegistrationId(runtime: HrcRuntimeSnapshot): string | undefined {
  const state = runtime.runtimeStateJson?.['externalRegistration']
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return undefined
  const registrationId = (state as Record<string, unknown>)['registrationId']
  return typeof registrationId === 'string' && registrationId.length > 0
    ? registrationId
    : undefined
}

function externalRegistrationState(runtime: HrcRuntimeSnapshot): Record<string, unknown> {
  const state = runtime.runtimeStateJson?.['externalRegistration']
  return state !== null && typeof state === 'object' && !Array.isArray(state)
    ? { ...(state as Record<string, unknown>) }
    : {}
}

/**
 * Operator eviction for an externally-owned runtime.
 *
 * This intentionally performs only HRC-owned effects: detach/finalize durable
 * state, revoke the attach token, close HRC's transport, and emit the audit
 * event. It never invokes a broker lifecycle RPC, signals a process, tears down
 * tmux/Ghostty substrate, drops continuation state, or mutates placement
 * authority.
 */
export async function evictExternalParticipant(
  server: HrcServerInstanceForHandlers,
  snapshot: HrcRuntimeSnapshot
): Promise<void> {
  const runtime = server.db.runtimes.getByRuntimeId(snapshot.runtimeId) ?? snapshot
  if (!isExternalLifecycleOwner(runtime)) return

  const registrationId = externalRegistrationId(runtime)
  const grant =
    registrationId === undefined
      ? undefined
      : (server.db.externalRegistrationGrants.getByRegistrationId(registrationId) ?? undefined)
  const invocationId = grant?.invocationId ?? runtime.activeInvocationId
  const now = timestamp()

  if (runtime.status !== 'terminated' || runtime.lifecycleTerminalReason !== 'operator_evict') {
    const externalRegistration = externalRegistrationState(runtime)
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
        control: { mode: 'epr', brokerAttached: false },
        externalRegistration: {
          ...externalRegistration,
          detachedAt:
            typeof externalRegistration['detachedAt'] === 'string'
              ? externalRegistration['detachedAt']
              : now,
          finalizedAt: now,
          finalReason: 'operator_evict',
          attachTokenRevokedAt: now,
        },
      },
    })
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

  // The token file is the re-entry authority. Keeping the redacted reference in
  // durable rows is useful forensic state; absence of the file is revocation.
  if (grant?.attachTokenRef !== undefined) {
    await rm(grant.attachTokenRef, { force: true })
  }

  if (registrationId !== undefined) {
    const client = server.externalParticipantClients.get(registrationId)
    server.externalParticipantClients.delete(registrationId)
    await client?.close().catch(() => undefined)
  }
}
