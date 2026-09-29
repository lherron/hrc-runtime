import type { ExternalRegistrationGrant } from 'hrc-store-sqlite'
import { validateEventEnvelope } from 'spaces-harness-broker-protocol'
import {
  type EprAttachment,
  externalRegistrationRetryDelayMs,
  finalizeExternalParticipant,
  lastAckedExternalSeq,
  lingerDeadlineMs,
  markExternalParticipantDetached,
  performExternalParticipantAttach,
  probeAttachedControl,
  projectReplayAndAck,
} from './external-registration-attach.js'
import { connectExternalParticipant } from './external-registration-client.js'
import {
  assertMintLinkage,
  performExternalRegistrationHello,
  registrationIsFinalized,
} from './external-registration-hello.js'
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS,
  DEFAULT_RENDEZVOUS_RETRY_BUDGET,
  DEFAULT_RENDEZVOUS_RETRY_MAX_MS,
  DEFAULT_RENDEZVOUS_RETRY_MS,
  EPR_CONTROLLER_FENCED_CODE,
  type EprEstablishedDelivery,
  EprHelloError,
  type ExternalParticipantRpcClient,
} from './external-registration-protocol.js'
import {
  EprReplayGapError,
  rpcErrorCode,
  rpcFailureCode,
  rpcFailureMethod,
} from './external-registration-rpc.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { timestamp } from './server-util.js'

export {
  DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS,
  EPR_CONTROLLER_FENCED_CODE,
  EPR_HELLO_ERROR_CODE,
  EPR_PROTOCOL_VERSION,
  EPR_REPLAY_UNAVAILABLE_CODE,
  EprHelloError,
  parseEprHelloResponse,
} from './external-registration-protocol.js'
export type {
  EprEstablishedDelivery,
  EprHelloErrorName,
  EprHelloResponse,
  ExternalParticipantCapabilities,
  ExternalParticipantClientFactory,
  ExternalParticipantInfo,
  ExternalParticipantNotification,
  ExternalParticipantRpcClient,
} from './external-registration-protocol.js'
export { performExternalRegistrationHello } from './external-registration-hello.js'
export {
  externalRegistrationRetryDelayMs,
  markExternalParticipantDetached,
  performExternalParticipantAttach,
} from './external-registration-attach.js'
export { connectExternalParticipant } from './external-registration-client.js'

function waitForRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function consumeExternalParticipantNotifications(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  client: ExternalParticipantRpcClient,
  controllerInstanceId: string
): Promise<'clean-exit' | 'stream-ended'> {
  if (client.streamNotifications === undefined) return 'stream-ended'
  for await (const notification of client.streamNotifications()) {
    if (notification.method !== 'invocation.event') {
      throw new Error(`unsupported external participant notification ${notification.method}`)
    }
    const envelope = validateEventEnvelope(notification.params)
    if (String(envelope.invocationId) !== grant.invocationId) {
      throw new Error('external participant notification crossed invocation identity')
    }
    const replay = await projectReplayAndAck(server, grant, client, controllerInstanceId)
    if (replay.cleanExit) return 'clean-exit'
  }
  return 'stream-ended'
}

async function runPeriodicExternalParticipantProbe(
  grant: ExternalRegistrationGrant,
  client: ExternalParticipantRpcClient,
  probe: EprEstablishedDelivery['probe']
): Promise<'probe-failed' | 'transport-closed'> {
  assertMintLinkage(grant)
  let consecutiveFailures = 0
  while (true) {
    if (client.waitForClose !== undefined) {
      const outcome = await Promise.race([
        waitForRetry(probe.intervalMs).then(() => 'interval' as const),
        client.waitForClose().then(() => 'closed' as const),
      ])
      if (outcome === 'closed') return 'transport-closed'
    } else {
      await waitForRetry(probe.intervalMs)
    }
    try {
      await probeAttachedControl(client, grant.invocationId, probe.deadlineMs, false)
      consecutiveFailures = 0
    } catch (error) {
      consecutiveFailures += 1
      writeServerLog('WARN', 'external_registration.probe_failed', {
        registrationId: grant.registrationId,
        runtimeId: grant.runtimeId,
        invocationId: grant.invocationId,
        consecutiveFailures,
        failureThreshold: probe.failureThreshold,
        error: error instanceof Error ? error.message : String(error),
      })
      if (consecutiveFailures >= probe.failureThreshold) {
        await client.close().catch(() => undefined)
        return 'probe-failed'
      }
    }
  }
}

async function maintainExternalParticipantAttachment(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  client: ExternalParticipantRpcClient,
  attachment: EprAttachment
): Promise<{ terminal: boolean; detail: Record<string, unknown> }> {
  if (client.streamNotifications === undefined || client.waitForClose === undefined) {
    // Structural test doubles used by A2 stop at identity delivery. The real
    // NDJSON client always exposes both long-lived surfaces.
    return { terminal: true, detail: { reason: 'non_streaming_test_client' } }
  }
  const notifications = consumeExternalParticipantNotifications(
    server,
    grant,
    client,
    attachment.controllerInstanceId
  ).then(
    (outcome) => ({ source: 'notifications' as const, outcome }),
    (error: unknown) => ({ source: 'notifications-error' as const, error })
  )
  const closed = client.waitForClose().then(() => ({ source: 'closed' as const }))
  const probes = runPeriodicExternalParticipantProbe(grant, client, attachment.probe).then(
    (outcome) => ({ source: 'probe' as const, outcome })
  )
  let outcome = await Promise.race([notifications, closed, probes])
  if (outcome.source === 'closed') {
    const drained = await notifications
    if (drained.source === 'notifications' && drained.outcome === 'clean-exit') outcome = drained
  }
  if (outcome.source === 'notifications' && outcome.outcome === 'clean-exit') {
    await client.close().catch(() => undefined)
    return { terminal: true, detail: { reason: 'external_participant_exit' } }
  }
  if (outcome.source === 'notifications-error') {
    await client.close().catch(() => undefined)
    return {
      terminal: false,
      detail: {
        reason: 'event_stream_error',
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        ...(rpcErrorCode(outcome.error) === EPR_CONTROLLER_FENCED_CODE
          ? { code: EPR_CONTROLLER_FENCED_CODE }
          : {}),
      },
    }
  }
  return {
    terminal: false,
    detail: {
      reason:
        outcome.source === 'probe' && outcome.outcome === 'probe-failed'
          ? 'probe_failure_threshold'
          : 'transport_closed',
    },
  }
}

export async function runExternalRegistrationRendezvous(
  this: HrcServerInstanceForHandlers,
  registrationId: string
): Promise<void> {
  const factory = this.options.externalParticipantClientFactory ?? connectExternalParticipant
  const retryBaseMs =
    this.options.externalParticipantRendezvousRetryMs ?? DEFAULT_RENDEZVOUS_RETRY_MS
  const retryMaxMs =
    this.options.externalParticipantRendezvousRetryMaxMs ?? DEFAULT_RENDEZVOUS_RETRY_MAX_MS
  const retryBudget = Math.max(
    1,
    Math.trunc(
      this.options.externalParticipantRendezvousRetryBudget ?? DEFAULT_RENDEZVOUS_RETRY_BUDGET
    )
  )
  const lingerMs =
    this.options.externalParticipantLingerMs ?? DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS
  let consecutiveFailures = 0
  while (!this.stopping) {
    const grant = this.db.externalRegistrationGrants.getByRegistrationId(registrationId)
    if (grant === null || (!grant.consumed && grant.expiresAt <= timestamp())) return
    if (registrationIsFinalized(this.db, grant)) return
    if (grant.consumed) {
      assertMintLinkage(grant)
      const runtime = this.db.runtimes.getByRuntimeId(grant.runtimeId)
      if (runtime === null) return
      if (runtime.status === 'detached') {
        const deadline = lingerDeadlineMs(this, grant, lingerMs)
        if (deadline !== undefined && Date.now() >= deadline) {
          finalizeExternalParticipant(this, grant, 'detached_expired')
          return
        }
      } else if (grant.establishmentState === 'ESTABLISHED') {
        return
      }
    }
    const dialMode = grant.establishmentState === 'ESTABLISHED' ? 'reattach' : 'established'

    let client: ExternalParticipantRpcClient | undefined
    let activeMethod = 'connect'
    try {
      client = await factory({
        socketPath: grant.socketPath,
        timeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      })
      this.externalParticipantClients.set(registrationId, client)
      const mode = dialMode
      let runtimeId: string
      let invocationId: string
      if (mode === 'established') {
        activeMethod = 'epr.hello'
        const result = await performExternalRegistrationHello(this, registrationId, client)
        runtimeId = result.delivery.runtimeId
        invocationId = result.delivery.invocationId
        writeServerLog('INFO', 'external_registration.established', {
          registrationId,
          branch: result.branch,
          runtimeId,
          invocationId,
        })
      } else {
        activeMethod = 'epr.reattach'
        const current = this.db.externalRegistrationGrants.getByRegistrationId(registrationId)
        if (current === null) throw new Error(`registration ${registrationId} disappeared`)
        assertMintLinkage(current)
        runtimeId = current.runtimeId
        invocationId = current.invocationId
      }
      if (client.streamNotifications === undefined || client.waitForClose === undefined) {
        this.externalParticipantClients.delete(registrationId)
        return
      }
      activeMethod = mode === 'established' ? 'invocation.snapshot' : 'epr.reattach'
      const attachment = await performExternalParticipantAttach(this, registrationId, client, mode)
      if (attachment.terminal) {
        await client.close().catch(() => undefined)
        this.externalParticipantClients.delete(registrationId)
        return
      }
      writeServerLog('INFO', 'external_registration.attached', {
        registrationId,
        runtimeId,
        invocationId,
        mode,
        ackedThroughSeq: lastAckedExternalSeq(this, runtimeId),
      })
      consecutiveFailures = 0
      const attachedGrant = this.db.externalRegistrationGrants.getByRegistrationId(registrationId)
      if (attachedGrant === null) {
        await client.close().catch(() => undefined)
        this.externalParticipantClients.delete(registrationId)
        return
      }
      activeMethod = 'invocation.eventsSince'
      const maintained = await maintainExternalParticipantAttachment(
        this,
        attachedGrant,
        client,
        attachment
      )
      if (maintained.terminal || this.stopping) {
        this.externalParticipantClients.delete(registrationId)
        return
      }
      markExternalParticipantDetached(this, attachedGrant, attachment.lingerMs, maintained.detail)
    } catch (error) {
      consecutiveFailures += 1
      if (client !== undefined && error instanceof EprHelloError) {
        await client
          .notify('epr.rejected', {
            registrationId,
            code: error.code,
            eprError: error.eprError,
            ...(error.eprError === 'registration_established' ? { data: { reattach: true } } : {}),
          })
          .catch(() => undefined)
      }
      await client?.close().catch(() => undefined)
      if (client !== undefined && this.externalParticipantClients.get(registrationId) === client) {
        this.externalParticipantClients.delete(registrationId)
      }
      if (error instanceof EprHelloError) {
        return
      }
      if (error instanceof EprReplayGapError) {
        writeServerLog('WARN', 'external_registration.replay_gap', {
          registrationId,
          error: error.message,
        })
        return
      }
      const latest = this.db.externalRegistrationGrants.getByRegistrationId(registrationId)
      if (
        latest?.consumed === true &&
        !registrationIsFinalized(this.db, latest) &&
        (latest.establishmentState === 'ESTABLISHED' || consecutiveFailures >= retryBudget)
      ) {
        assertMintLinkage(latest)
        markExternalParticipantDetached(this, latest, lingerMs, {
          reason:
            latest.establishmentState === 'DELIVERY_PENDING' ? 'delivery_timeout' : 'attach_failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      const retryInMs = externalRegistrationRetryDelayMs(
        consecutiveFailures,
        retryBaseMs,
        retryMaxMs
      )
      writeServerLog('WARN', 'external_registration.rendezvous_retry', {
        registrationId,
        method: rpcFailureMethod(error) ?? activeMethod,
        code: rpcFailureCode(error),
        error: error instanceof Error ? error.message : String(error),
        consecutiveFailures,
        retryBudget,
        retryInMs,
        ...(error instanceof EprHelloError ? { code: error.code, eprError: error.eprError } : {}),
      })
    }
    if (client !== undefined && this.externalParticipantClients.get(registrationId) === client) {
      this.externalParticipantClients.delete(registrationId)
    }
    if (!this.stopping) {
      await waitForRetry(
        externalRegistrationRetryDelayMs(consecutiveFailures, retryBaseMs, retryMaxMs)
      )
    }
  }
}

export function scheduleExternalRegistrationRendezvous(
  this: HrcServerInstanceForHandlers,
  registrationId: string
): void {
  if (this.externalRegistrationOperations.has(registrationId)) return
  const operation = this.runExternalRegistrationRendezvous(registrationId).finally(() => {
    this.externalRegistrationOperations.delete(registrationId)
  })
  this.externalRegistrationOperations.set(registrationId, operation)
}

export const externalRegistrationRendezvousMethods = {
  runExternalRegistrationRendezvous,
  scheduleExternalRegistrationRendezvous,
}

export type ExternalRegistrationRendezvousMethods = typeof externalRegistrationRendezvousMethods
