import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ExternalRegistrationGrant } from 'hrc-store-sqlite'
import {
  type InvocationEventEnvelope,
  type InvocationSnapshot,
  validateEventEnvelope,
} from 'spaces-harness-broker-protocol'

import { runtimeStatusFromInvocationState } from './broker/runtime-state.js'
import { assertMintLinkage, registrationIsFinalized } from './external-registration-hello.js'
import {
  DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS,
  DEFAULT_PROBE_FAILURE_THRESHOLD,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_RENDEZVOUS_RETRY_MAX_MS,
  DEFAULT_RENDEZVOUS_RETRY_MS,
  type EprEstablishedDelivery,
  type ExternalParticipantRpcClient,
  externalParticipantRpcDeadlineMs,
  isRecord,
} from './external-registration-protocol.js'
import {
  EprReplayGapError,
  requestExternalParticipantRpc,
  requestReplayPlane,
} from './external-registration-rpc.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'

export type EprAttachment = {
  controllerInstanceId: string
  snapshot: InvocationSnapshot
  probe: EprEstablishedDelivery['probe']
  lingerMs: number
  terminal: boolean
}

export function externalRegistrationRetryDelayMs(
  consecutiveFailures: number,
  baseMs = DEFAULT_RENDEZVOUS_RETRY_MS,
  maxMs = DEFAULT_RENDEZVOUS_RETRY_MAX_MS
): number {
  const cap = Number.isFinite(maxMs) ? Math.max(1, Math.trunc(maxMs)) : 1
  const base = Number.isFinite(baseMs) ? Math.min(cap, Math.max(1, Math.trunc(baseMs))) : cap
  const failureCount = Number.isFinite(consecutiveFailures) ? Math.trunc(consecutiveFailures) : 1
  const exponent = Math.max(0, Math.min(30, failureCount - 1))
  return Math.min(cap, base * 2 ** exponent)
}

function integerAtLeast(value: unknown, minimum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`)
  }
  return value as number
}

function parseInvocationSnapshot(value: unknown, invocationId: string): InvocationSnapshot {
  if (!isRecord(value) || value['invocationId'] !== invocationId) {
    throw new Error('invocation.snapshot returned the wrong invocation')
  }
  if (typeof value['state'] !== 'string' || !isRecord(value['capabilities'])) {
    throw new Error('invocation.snapshot has invalid state or capabilities')
  }
  integerAtLeast(value['currentSeq'], 0, 'invocation.snapshot currentSeq')
  integerAtLeast(value['retentionFloorSeq'], 0, 'invocation.snapshot retentionFloorSeq')
  if (
    !Array.isArray(value['pendingInputIds']) ||
    !isRecord(value['inputDispositions']) ||
    !Array.isArray(value['pendingPermissionRequests'])
  ) {
    throw new Error('invocation.snapshot has invalid durable read-model fields')
  }
  return value as unknown as InvocationSnapshot
}

function parseEventsSinceResponse(value: unknown): {
  events: InvocationEventEnvelope[]
  currentSeq: number
  retentionFloorSeq: number
} {
  if (!isRecord(value) || !Array.isArray(value['events'])) {
    throw new Error('invocation.eventsSince response must contain events')
  }
  return {
    events: value['events'].map((event) => validateEventEnvelope(event)),
    currentSeq: integerAtLeast(value['currentSeq'], 0, 'invocation.eventsSince currentSeq'),
    retentionFloorSeq: integerAtLeast(
      value['retentionFloorSeq'],
      0,
      'invocation.eventsSince retentionFloorSeq'
    ),
  }
}

function externalRegistrationState(
  runtimeStateJson: Record<string, unknown> | undefined
): Record<string, unknown> {
  const state = runtimeStateJson?.['externalRegistration']
  return isRecord(state) ? { ...state } : {}
}

export function lastAckedExternalSeq(
  server: HrcServerInstanceForHandlers,
  runtimeId: string
): number {
  const runtime = server.db.runtimes.getByRuntimeId(runtimeId)
  const state = runtime?.runtimeStateJson?.['externalRegistration']
  const value = isRecord(state) ? state['ackedThroughSeq'] : undefined
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0
}

function writeExternalRegistrationState(
  server: HrcServerInstanceForHandlers,
  runtimeId: string,
  patch: Record<string, unknown>,
  now = timestamp()
): void {
  const runtime = server.db.runtimes.getByRuntimeId(runtimeId)
  if (runtime === null) throw new Error(`external runtime ${runtimeId} is missing`)
  const externalRegistration = externalRegistrationState(runtime.runtimeStateJson)
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete externalRegistration[key]
    else externalRegistration[key] = value
  }
  server.db.runtimes.update(runtimeId, {
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      externalRegistration,
      updatedAt: now,
    },
    updatedAt: now,
  })
}

export function markExternalParticipantDetached(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  lingerMs: number,
  detail: Record<string, unknown> = {}
): void {
  assertMintLinkage(grant)
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  if (runtime === null || registrationIsFinalized(server.db, grant)) return
  const current = externalRegistrationState(runtime.runtimeStateJson)
  const now = timestamp()
  const detachedAt =
    runtime.status === 'detached' && typeof current['detachedAt'] === 'string'
      ? current['detachedAt']
      : now
  const lingerDeadlineAt = new Date(Date.parse(detachedAt) + lingerMs).toISOString()
  server.db.runtimes.update(grant.runtimeId, {
    status: 'detached',
    statusChangedAt: runtime.status === 'detached' ? runtime.statusChangedAt : now,
    ...runtimeActivityPatch(server.db, grant.runtimeId, {
      source: 'housekeeping',
      updatedAt: now,
    }),
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'detached',
      updatedAt: now,
      control: { mode: 'epr', brokerAttached: false, ...detail },
      externalRegistration: { ...current, detachedAt, lingerDeadlineAt },
    },
  })
}

export function finalizeExternalParticipant(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  reason: 'replay_gap' | 'detached_expired'
): void {
  assertMintLinkage(grant)
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  if (runtime === null || registrationIsFinalized(server.db, grant)) return
  const now = timestamp()
  const externalRegistration = externalRegistrationState(runtime.runtimeStateJson)
  server.db.brokerInvocations.update(grant.invocationId, {
    invocationState: 'failed',
    lifecycleTerminalReason: reason,
    updatedAt: now,
  })
  server.db.runtimes.update(grant.runtimeId, {
    status: 'terminated',
    statusChangedAt: now,
    lifecycleTerminalReason: reason,
    ...runtimeActivityPatch(server.db, grant.runtimeId, {
      source: 'housekeeping',
      updatedAt: now,
    }),
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'terminated',
      updatedAt: now,
      terminalReason: reason,
      control: { mode: 'epr', brokerAttached: false },
      externalRegistration: { ...externalRegistration, finalizedAt: now, finalReason: reason },
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
    payload: { reason, invocationId: grant.invocationId },
  })
  server.ctx?.notifyEvent(event)
}

export function lingerDeadlineMs(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  lingerMs: number
): number | undefined {
  if (grant.runtimeId === undefined) return undefined
  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  const state = runtime?.runtimeStateJson?.['externalRegistration']
  const deadline = isRecord(state) ? state['lingerDeadlineAt'] : undefined
  if (typeof deadline === 'string') return Date.parse(deadline)
  if (runtime?.status === 'detached') return Date.now() + lingerMs
  return undefined
}

export async function projectReplayAndAck(
  server: HrcServerInstanceForHandlers,
  grant: ExternalRegistrationGrant,
  client: ExternalParticipantRpcClient,
  controllerInstanceId: string
): Promise<{ throughSeq: number; cleanExit: boolean }> {
  assertMintLinkage(grant)
  const rpcDeadlineMs = externalParticipantRpcDeadlineMs(server.options)
  const lastAckedSeq = lastAckedExternalSeq(server, grant.runtimeId)
  const rawReplay = await requestReplayPlane(
    client,
    'invocation.eventsSince',
    {
      invocationId: grant.invocationId,
      afterSeq: lastAckedSeq,
    },
    rpcDeadlineMs
  )
  const replay = parseEventsSinceResponse(rawReplay)
  if (lastAckedSeq < replay.retentionFloorSeq) {
    throw new EprReplayGapError(
      `last ACK ${lastAckedSeq} is below retention floor ${replay.retentionFloorSeq}`
    )
  }

  let throughSeq = lastAckedSeq
  let cleanExit = false
  for (const envelope of replay.events) {
    if (String(envelope.invocationId) !== grant.invocationId) {
      throw new Error('participant replay crossed invocation identity')
    }
    if (envelope.seq <= throughSeq) continue
    if (envelope.seq !== throughSeq + 1) {
      throw new Error(`participant replay is not contiguous at seq ${envelope.seq}`)
    }
    if (throughSeq === 0 && envelope.type !== 'invocation.started') {
      throw new Error('first external participant event must be invocation.started')
    }
    const controller = server.harnessBrokerController ?? server.getHarnessBrokerController()
    await controller.projectExternalParticipantEvent(grant.runtimeId, envelope)
    throughSeq = envelope.seq
    cleanExit ||= envelope.type === 'invocation.exited'
  }
  const controller = server.harnessBrokerController ?? server.getHarnessBrokerController()
  controller.flushExternalParticipantIgnoredDeltas(grant.invocationId)
  if (throughSeq !== replay.currentSeq) {
    throw new Error(
      `participant replay ended at ${throughSeq}, behind declared currentSeq ${replay.currentSeq}`
    )
  }
  if (throughSeq > lastAckedSeq) {
    const ack = await requestExternalParticipantRpc(
      client,
      'invocation.ackEvents',
      {
        invocationId: grant.invocationId,
        throughSeq,
        controllerInstanceId,
      },
      rpcDeadlineMs
    )
    if (!isRecord(ack) || ack['ackedThroughSeq'] !== throughSeq) {
      throw new Error('invocation.ackEvents did not acknowledge the replay high-water')
    }
    writeExternalRegistrationState(server, grant.runtimeId, { ackedThroughSeq: throughSeq })
  }
  return { throughSeq, cleanExit }
}

export async function probeAttachedControl(
  client: ExternalParticipantRpcClient,
  invocationId: string,
  deadlineMs: number,
  full: boolean
): Promise<void> {
  if (full) {
    const health = await requestExternalParticipantRpc(
      client,
      'broker.health',
      { probeDrivers: false },
      deadlineMs
    )
    if (!isRecord(health) || !Number.isInteger(health['activeInvocations'])) {
      throw new Error('broker.health returned a malformed response')
    }
    if (health['status'] === 'shutting_down') throw new Error('participant is shutting down')
    if (health['status'] !== 'ok' && health['status'] !== 'degraded') {
      throw new Error(`participant health status is ${String(health['status'])}`)
    }
  }
  const status = await requestExternalParticipantRpc(
    client,
    'invocation.status',
    { invocationId },
    deadlineMs
  )
  if (
    !isRecord(status) ||
    status['invocationId'] !== invocationId ||
    typeof status['state'] !== 'string'
  ) {
    throw new Error('invocation.status returned the wrong invocation')
  }
}

function parseReattachResponse(
  value: unknown,
  invocationId: string
): { snapshot: InvocationSnapshot; currentSeq: number; retentionFloorSeq: number } {
  if (
    !isRecord(value) ||
    value['attached'] !== true ||
    typeof value['participantInstanceId'] !== 'string'
  ) {
    throw new Error('epr.reattach returned a malformed response')
  }
  return {
    snapshot: parseInvocationSnapshot(value['snapshot'], invocationId),
    currentSeq: integerAtLeast(value['currentSeq'], 0, 'epr.reattach currentSeq'),
    retentionFloorSeq: integerAtLeast(
      value['retentionFloorSeq'],
      0,
      'epr.reattach retentionFloorSeq'
    ),
  }
}

export async function performExternalParticipantAttach(
  server: HrcServerInstanceForHandlers,
  registrationId: string,
  client: ExternalParticipantRpcClient,
  mode: 'established' | 'reattach'
): Promise<EprAttachment> {
  const grant = server.db.externalRegistrationGrants.getByRegistrationId(registrationId)
  if (grant === null) throw new Error(`registration ${registrationId} is unknown`)
  assertMintLinkage(grant)
  const probe: EprEstablishedDelivery['probe'] = {
    intervalMs: server.options.externalParticipantProbeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS,
    deadlineMs: externalParticipantRpcDeadlineMs(server.options),
    failureThreshold:
      server.options.externalParticipantProbeFailureThreshold ?? DEFAULT_PROBE_FAILURE_THRESHOLD,
  }
  const lingerMs =
    server.options.externalParticipantLingerMs ?? DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS
  let controllerInstanceId = grant.controllerInstanceId
  let snapshot: InvocationSnapshot

  try {
    if (mode === 'reattach') {
      controllerInstanceId = `controller-${randomUUID()}`
      const attachToken = (await readFile(grant.attachTokenRef, 'utf8')).trim()
      const attached = await requestReplayPlane(
        client,
        'epr.reattach',
        {
          registrationId,
          invocationId: grant.invocationId,
          attachToken,
          controllerInstanceId,
          lastAckedSeq: lastAckedExternalSeq(server, grant.runtimeId),
        },
        probe.deadlineMs
      )
      const response = parseReattachResponse(attached, grant.invocationId)
      if (lastAckedExternalSeq(server, grant.runtimeId) < response.retentionFloorSeq) {
        throw new EprReplayGapError('reattach retention floor is past HRC ACK high-water')
      }
      snapshot = response.snapshot
      if (
        !server.db.externalRegistrationGrants.updateControllerInstanceId(
          registrationId,
          controllerInstanceId
        )
      ) {
        throw new Error(`registration ${registrationId} lost its established controller fence`)
      }
      writeExternalRegistrationState(server, grant.runtimeId, { controllerInstanceId })
    } else {
      const rawSnapshot = await requestReplayPlane(
        client,
        'invocation.snapshot',
        { invocationId: grant.invocationId },
        probe.deadlineMs
      )
      snapshot = parseInvocationSnapshot(rawSnapshot, grant.invocationId)
    }

    const replay = await projectReplayAndAck(server, grant, client, controllerInstanceId)
    if (replay.cleanExit) return { controllerInstanceId, snapshot, probe, lingerMs, terminal: true }
  } catch (error) {
    if (error instanceof EprReplayGapError) {
      finalizeExternalParticipant(server, grant, 'replay_gap')
    }
    throw error
  }
  await probeAttachedControl(client, grant.invocationId, probe.deadlineMs, true)

  const runtime = server.db.runtimes.getByRuntimeId(grant.runtimeId)
  if (runtime === null || registrationIsFinalized(server.db, grant)) {
    return { controllerInstanceId, snapshot, probe, lingerMs, terminal: true }
  }
  const now = timestamp()
  const status = runtimeStatusFromInvocationState(snapshot.state)
  const externalRegistration = externalRegistrationState(runtime.runtimeStateJson)
  externalRegistration['detachedAt'] = undefined
  externalRegistration['lingerDeadlineAt'] = undefined
  server.db.brokerInvocations.update(grant.invocationId, {
    invocationState: snapshot.state,
    capabilitiesJson: JSON.stringify(snapshot.capabilities),
    ownerServerInstanceId: controllerInstanceId,
    updatedAt: now,
  })
  server.db.runtimes.update(grant.runtimeId, {
    status,
    statusChangedAt: now,
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status,
      updatedAt: now,
      control: { mode: 'epr', brokerAttached: true },
      externalRegistration: {
        ...externalRegistration,
        controllerInstanceId,
        ackedThroughSeq: lastAckedExternalSeq(server, grant.runtimeId),
        attachedAt: now,
      },
    },
    updatedAt: now,
  })
  return { controllerInstanceId, snapshot, probe, lingerMs, terminal: false }
}
