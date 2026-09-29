/**
 * The durable-reattach dispatch flow — `attachAndReplay()` (reattach + event
 * replay/ack) and the frozen-release reader it depends on.
 */

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { BrokerInvocationEventConflictError } from 'hrc-store-sqlite'
import type { AspcExecutionRelease } from 'spaces-aspc-protocol'
import type { InvocationId } from 'spaces-harness-broker-protocol'

import { workerHelloRefusal } from '../../agent-spaces-adapter/aspd-execution-release'
import { deriveRuntimeStatusWithAwaiting } from '../../ask-bracket'
import { runtimeActivityPatch } from '../../runtime-activity'
import { parseBrokerRuntimeHostingState } from '../runtime-hosting'
import { runtimeStatusFromInvocationState } from '../runtime-state'
import type { DispatchContext } from './dispatch-context'
import { proveReattachedBrokerControl } from './dispatch-probe'
import { BrokerControllerError } from './errors'
import {
  rehydrateInspectionCapabilities,
  replayBelowFloorDetail,
  toControllerError,
} from './internal'
import { failReplayStale } from './lifecycle'
import type { BrokerControllerAttachInput, BrokerControllerAttachResult } from './types'

/** The frozen execution release a runtime was started from, when aspd-prepared. */
export function persistedAspdExecutionRelease(
  runtime: HrcRuntimeSnapshot
): AspcExecutionRelease | undefined {
  const record = runtime.runtimeStateJson?.['executionRelease']
  if (typeof record !== 'object' || record === null) return undefined
  const value = record as Record<string, unknown>
  const worker = value['worker'] as Record<string, unknown> | undefined
  if (
    value['source'] !== 'aspd' ||
    typeof value['releaseId'] !== 'string' ||
    typeof value['sourceCommit'] !== 'string' ||
    typeof value['builtAt'] !== 'string' ||
    typeof value['releaseRoot'] !== 'string' ||
    typeof worker?.['protocol'] !== 'string' ||
    typeof worker['executable'] !== 'string' ||
    !Array.isArray(worker['argvPrefix'])
  ) {
    return undefined
  }
  return {
    releaseId: value['releaseId'],
    sourceCommit: value['sourceCommit'],
    builtAt: value['builtAt'],
    releaseRoot: value['releaseRoot'],
    worker: {
      protocol: worker['protocol'] as AspcExecutionRelease['worker']['protocol'],
      executable: worker['executable'],
      argvPrefix: worker['argvPrefix'] as string[],
    },
  }
}

export async function attachAndReplay(
  ctx: DispatchContext,
  input: BrokerControllerAttachInput
): Promise<BrokerControllerAttachResult> {
  const runtime = ctx.db.runtimes.getByRuntimeId(input.runtimeId)
  const invocation = ctx.resolveAttachInvocation(runtime, input.runtimeId)
  if (!runtime || !invocation) {
    return {
      ok: false,
      brokerAttached: false,
      error: new BrokerControllerError(
        'broker_attach_unknown_runtime',
        `cannot attach broker runtime ${input.runtimeId}: persisted runtime/invocation not found`,
        {
          runtimeFound: runtime !== null,
          invocationFound: invocation !== null,
        }
      ),
    }
  }

  const hosting = parseBrokerRuntimeHostingState(runtime)
  const brokerState = runtime.runtimeStateJson?.['broker']
  const brokerRecord =
    typeof brokerState === 'object' && brokerState !== null
      ? (brokerState as Record<string, unknown>)
      : undefined
  const traceStartedAt = performance.now()
  let previousTraceAt = traceStartedAt
  const baseTrace = {
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    generation: runtime.generation,
    invocationId: invocation.invocationId,
    serverInstanceId: ctx.serverInstanceId,
    ...(hosting?.endpoint.kind === 'unix-jsonrpc-ndjson'
      ? { endpointSocketPath: hosting.endpoint.socketPath }
      : {}),
    ...(hosting?.substrate.kind === 'leased-tmux'
      ? {
          leaseTmuxSocketPath: hosting.substrate.tmuxSocketPath,
          leaseSessionName: hosting.substrate.sessionName,
          leaseSessionId: hosting.substrate.brokerWindow.sessionId,
          leaseBrokerWindowId: hosting.substrate.brokerWindow.windowId,
          leaseBrokerPaneId: hosting.substrate.brokerWindow.paneId,
        }
      : {}),
    ...(typeof brokerRecord?.['brokerPid'] === 'number'
      ? { persistedBrokerPid: brokerRecord['brokerPid'] }
      : {}),
  }
  const trace = (phase: string, fields: Record<string, unknown> = {}): void => {
    const now = performance.now()
    ctx.logger.info?.('broker.reattach.phase', {
      ...baseTrace,
      phase,
      phaseElapsedMs: Number((now - previousTraceAt).toFixed(1)),
      totalElapsedMs: Number((now - traceStartedAt).toFixed(1)),
      ...fields,
    })
    previousTraceAt = now
  }

  const lastProjectedSeq = ctx.lastProjectedBrokerSeq(invocation.invocationId)
  // The candidate owns every close from this point, including closes triggered
  // by failReplayStale. Register before replay so an intentional-close marker
  // cannot outlive the client that minted it and poison a later same-ID attach.
  input.client.onClose((error) => {
    ctx.handleBrokerClose(runtime.runtimeId, error, input.client)
  })
  try {
    // T-08542: an aspd-prepared worker is reattached only after it proves, on
    // this candidate connection, that it is still the frozen release. No aspd
    // and no preparation participate in reattachment.
    const frozenRelease = persistedAspdExecutionRelease(runtime)
    if (frozenRelease !== undefined) {
      const hello = await input.client.hello({
        clientInfo: { name: 'hrc-server' },
        protocolVersions: [frozenRelease.worker.protocol],
      })
      const refusal = workerHelloRefusal(frozenRelease, hello)
      if (refusal !== undefined) {
        throw new BrokerControllerError(
          'broker_reattach_release_mismatch',
          `reattach refused: ${refusal.message}`,
          { ...refusal.detail, refusal: refusal.code, runtimeId: runtime.runtimeId }
        )
      }
      trace('release.verified', {
        releaseId: frozenRelease.releaseId,
        protocolVersion: hello.protocolVersion,
      })
    }
    trace('attach.begin', { lastProjectedSeq })
    const attach = await input.client.attach({
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      generation: runtime.generation,
      invocationId: invocation.invocationId as InvocationId,
      startRequestHash: invocation.startRequestHash,
      selectedProfileHash: invocation.selectedProfileHash,
      controllerInstanceId: ctx.serverInstanceId,
      attachToken: input.attachToken,
      lastProjectedSeq,
    })
    trace('attach.complete', {
      brokerInstanceId: attach.brokerInstanceId,
      activeControllerInstanceId: attach.activeControllerInstanceId,
      currentSeq: attach.currentSeq,
      retentionFloorSeq: attach.retentionFloorSeq,
    })
    const snapshot = await input.client.snapshot({
      invocationId: invocation.invocationId as InvocationId,
    })
    trace('snapshot.complete', {
      invocationState: snapshot.state,
      currentSeq: snapshot.currentSeq,
      retentionFloorSeq: snapshot.retentionFloorSeq,
    })

    const retentionFloorSeq = Math.max(
      attach.retentionFloorSeq,
      attach.snapshot.retentionFloorSeq,
      snapshot.retentionFloorSeq
    )
    if (retentionFloorSeq > lastProjectedSeq + 1) {
      const error = new BrokerControllerError(
        'broker_replay_retention_gap',
        'broker event retention floor is past HRC projected high-water',
        {
          runtimeId: runtime.runtimeId,
          invocationId: invocation.invocationId,
          lastProjectedSeq,
          retentionFloorSeq,
        }
      )
      await failReplayStale(ctx.lifecycleContext(), runtime, invocation, input.client, error)
      return { ok: false, brokerAttached: false, error }
    }

    const replay = await input.client.eventsSince({
      invocationId: invocation.invocationId as InvocationId,
      afterSeq: lastProjectedSeq,
    })
    trace('replay.read', {
      eventCount: replay.events.length,
      currentSeq: replay.currentSeq,
      retentionFloorSeq: replay.retentionFloorSeq,
    })

    let replayedThroughSeq = lastProjectedSeq
    let ackedThroughSeq = lastProjectedSeq
    for (const envelope of replay.events) {
      const result = ctx.mapper.apply(envelope)
      if (result.ignoredDelta) {
        replayedThroughSeq = Math.max(replayedThroughSeq, envelope.seq)
        continue
      }
      await ctx.testOnlyAfterProjectionCommitBeforeAck?.({
        runtimeId: runtime.runtimeId,
        invocationId: String(envelope.invocationId),
        committedThroughSeq: ctx.lastProjectedBrokerSeq(String(envelope.invocationId)),
      })
      ctx.afterMappedEvent(runtime.runtimeId, envelope, result)
      replayedThroughSeq = Math.max(replayedThroughSeq, envelope.seq)
    }
    ctx.mapper.flushIgnoredDeltas?.(invocation.invocationId)

    // The durable contiguous projection cursor is the acknowledgement
    // authority. Re-read it after every transaction and re-ack even when this
    // replay returned no envelopes (crash after commit, before prior ack).
    ackedThroughSeq = ctx.lastProjectedBrokerSeq(invocation.invocationId)
    if (ackedThroughSeq > 0) {
      const ack = await input.client.ackEvents({
        invocationId: invocation.invocationId as InvocationId,
        throughSeq: ackedThroughSeq,
        controllerInstanceId: ctx.serverInstanceId,
      })
      if (ack.ackedThroughSeq < ackedThroughSeq) {
        throw new BrokerControllerError(
          'broker_ack_incomplete',
          'broker acknowledgement did not reach HRC committed projection cursor',
          {
            runtimeId: runtime.runtimeId,
            invocationId: invocation.invocationId,
            committedThroughSeq: ackedThroughSeq,
            ackedThroughSeq: ack.ackedThroughSeq,
          }
        )
      }
      ackedThroughSeq = ack.ackedThroughSeq
    }
    trace('replay.ack', { replayedThroughSeq, ackedThroughSeq })

    // T-05299: attach/replay methods sharing a socket do not prove the broker's
    // control plane can service inspect/dispatch/terminate RPCs. Prove both
    // broker health and the expected invocation status on this exact candidate
    // client, with an independent bound per RPC, before publishing owner state,
    // brokerAttached, active, or the live event subscription.
    await proveReattachedBrokerControl(ctx, input, runtime, invocation, trace)

    // T-01946 gate 2 (restart re-derivation): the broker reports `turn_active`
    // for a parked turn (it has no awaiting-input member), which would clobber
    // the awaiting_input status that replay just projected. Re-derive from the
    // durable ask bracket so a reattach during a park keeps the runtime honest.
    const baseStatus = runtimeStatusFromInvocationState(snapshot.state)
    const refreshedRuntime = ctx.db.runtimes.getByRuntimeId(runtime.runtimeId)
    const status = refreshedRuntime
      ? deriveRuntimeStatusWithAwaiting(ctx.db, refreshedRuntime, baseStatus)
      : baseStatus
    const now = ctx.now()
    ctx.db.brokerInvocations.update(invocation.invocationId, {
      invocationState: snapshot.state,
      capabilitiesJson: JSON.stringify(snapshot.capabilities),
      ownerServerInstanceId: ctx.serverInstanceId,
      updatedAt: now,
    })
    ctx.db.runtimes.update(runtime.runtimeId, {
      status,
      activeInvocationId: invocation.invocationId,
      ...runtimeActivityPatch(ctx.db, runtime.runtimeId, {
        source: 'housekeeping',
        updatedAt: now,
      }),
      runtimeStateJson: {
        ...(runtime.runtimeStateJson ?? {}),
        status,
        updatedAt: now,
        control: {
          mode: 'broker-ipc',
          brokerAttached: true,
        },
        brokerReplay: {
          brokerInstanceId: attach.brokerInstanceId,
          activeControllerInstanceId: attach.activeControllerInstanceId,
          lastProjectedSeq,
          replayedThroughSeq,
          ackedThroughSeq,
          currentSeq: Math.max(attach.currentSeq, snapshot.currentSeq, replay.currentSeq),
          retentionFloorSeq: Math.max(retentionFloorSeq, replay.retentionFloorSeq),
        },
      },
    })

    ctx.mapper.projectCaptureState?.(runtime.runtimeId, snapshot.capture)

    ctx.setActive({
      runtimeId: runtime.runtimeId,
      invocationId: invocation.invocationId,
      client: input.client,
      closing: false,
      // T-01855: durable reattach rebuilds `active` WITHOUT a fresh hello, so
      // rehydrate inspection capabilities from persisted broker state. A later
      // fresh hello (generation/reattach) replaces this best-effort fallback.
      inspection: rehydrateInspectionCapabilities(runtime.runtimeStateJson),
    })
    trace('active.published', {
      replayedThroughSeq,
      ackedThroughSeq,
      finalStatus: status,
    })

    // T-01801: subscribe to the broker's LIVE event stream after the one-shot
    // `eventsSince` replay. Without this the runtime is re-attached for INPUT
    // but every subsequent turn's events stay in the broker's durable ledger
    // and never project into hrc_events, so the semantic turn never finalizes.
    // `streamInvocationEvents` drains events buffered since the attach (de-duped
    // by seq) then yields live ones; `consumeEvents` projects idempotently
    // (mapper marks already-applied seqs idempotent + the events table is UNIQUE
    // on (invocation_id, seq)), so the overlap with the replay above is safe.
    const liveEvents = input.client.streamInvocationEvents?.(
      invocation.invocationId as InvocationId
    )
    if (liveEvents) {
      ctx.consumeEvents(runtime.runtimeId, liveEvents)
    }
    trace('stream.subscribed', { subscribed: liveEvents !== undefined })

    return {
      ok: true,
      brokerAttached: true,
      replayedThroughSeq,
      ackedThroughSeq,
      acceptedInputIds: Object.entries(snapshot.inputDispositions ?? {})
        .filter(([, disposition]) => disposition.accepted)
        .map(([inputId]) => inputId),
    }
  } catch (error) {
    const belowFloor = replayBelowFloorDetail(error)
    const controllerError = belowFloor
      ? new BrokerControllerError(
          'broker_replay_below_floor',
          'broker rejected replay below its retained event floor',
          belowFloor
        )
      : error instanceof BrokerInvocationEventConflictError
        ? new BrokerControllerError(
            'broker_replay_conflict',
            'broker replay produced a conflicting durable event payload',
            {
              conflict: true,
              invocationId: error.invocationId,
              seq: error.seq,
              name: error.name,
            }
          )
        : toControllerError('broker_attach_replay_failed', error)
    trace('failed', {
      result: 'failed',
      errorCode: controllerError.code,
      errorMessage: controllerError.message,
    })
    await failReplayStale(
      ctx.lifecycleContext(),
      runtime,
      invocation,
      input.client,
      controllerError
    )
    return { ok: false, brokerAttached: false, error: controllerError }
  }
}
