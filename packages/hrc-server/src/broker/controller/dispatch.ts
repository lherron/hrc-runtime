/**
 * The two large dispatch flows for HarnessBrokerController — `start()` (launch +
 * negotiate + persist + begin consuming) and `attachAndReplay()` (durable
 * reattach + event replay/ack). Extracted verbatim from controller.ts as a
 * mechanical move; both take an explicit `DispatchContext` instead of `this`, so
 * behavior is byte-for-byte identical at the call site. Nothing here is part of
 * the controller's public export surface.
 */

import type { HrcBrokerInvocationRecord, HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { BrokerInvocationEventConflictError } from 'hrc-store-sqlite'
import type { StdioTransportStartOptions } from 'spaces-harness-broker-client'
import type {
  InvocationEventEnvelope,
  InvocationId,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'

import { deriveRuntimeStatusWithAwaiting } from '../../ask-bracket'
import {
  type ExpectedBrokerNegotiation,
  admitBrokerHello,
  admitStartedInvocation,
  preflightBrokerLifecyclePolicy,
} from '../capabilities'
import { BROKER_PROTOCOL_VERSION, BROKER_TRANSPORT, BROKER_TRANSPORT_UNIX } from '../constants'
import type { BrokerEventMapper, BrokerProjectionResult } from '../event-mapper'
import {
  isBrokerTmuxProfile,
  runtimeStatusFromInvocationState,
  toDispatchRuntime,
} from '../runtime-state'
import { allocateHeadlessSubstrate, allocateTmuxIfRequired } from './allocation'
import type { AllocationContext } from './allocation'
import { BrokerControllerError } from './errors'
import { compactEnv, rehydrateInspectionCapabilities, toControllerError } from './internal'
import { failReplayStale } from './lifecycle'
import type { LifecycleContext } from './lifecycle'
import {
  buildRuntimeStateJson,
  markStartedInvocationFailed,
  persistStartGraph,
} from './persistence'
import type { PersistenceContext } from './persistence'
import type {
  BrokerAttachedLaunchInput,
  BrokerClientFactory,
  BrokerClientLike,
  BrokerControllerAttachInput,
  BrokerControllerAttachResult,
  BrokerControllerLogger,
  BrokerControllerStartInput,
  BrokerControllerStartResult,
  BrokerTmuxAllocation,
  BrokerUnixClientFactory,
  DurableBrokerClientLike,
} from './types'

export type DispatchContext = {
  db: HrcDatabase
  mapper: Pick<BrokerEventMapper, 'apply'>
  brokerClientFactory: BrokerClientFactory
  brokerUnixClientFactory: BrokerUnixClientFactory
  brokerCommand: string
  brokerArgs: string[]
  env: Record<string, string | undefined> | undefined
  now: () => string
  serverInstanceId: string
  logger: BrokerControllerLogger
  persistenceContext: () => PersistenceContext
  allocationContext: () => AllocationContext
  lifecycleContext: () => LifecycleContext
  handlePermissionRequest: (request: PermissionRequestParams) => Promise<PermissionDecision>
  handleBrokerClose: (runtimeId: string, error: Error) => void
  markBrokerClosing: (runtimeId: string, reason: string) => void
  setActive: (record: {
    runtimeId: string
    invocationId: string
    client: BrokerClientLike
    closing: boolean
    inspection?: ReturnType<typeof rehydrateInspectionCapabilities>
  }) => void
  consumeEvents: (runtimeId: string, events: AsyncIterable<InvocationEventEnvelope>) => void
  afterMappedEvent: (
    runtimeId: string,
    envelope: InvocationEventEnvelope,
    result: BrokerProjectionResult
  ) => void
  resolveAttachInvocation: (
    runtime: HrcRuntimeSnapshot | null,
    runtimeId: string
  ) => HrcBrokerInvocationRecord | null
  lastProjectedBrokerSeq: (invocationId: string) => number
  connectDurableBrokerWithRetry: (
    socketPath: string,
    runtimeId: string
  ) => Promise<DurableBrokerClientLike>
  pauseForAttachedInvocationStart: (input: {
    pending: BrokerAttachedLaunchInput
    runtime: HrcRuntimeSnapshot
    allocation: BrokerTmuxAllocation
  }) => Promise<void>
  registerInvocation?: (input: {
    runtime: HrcRuntimeSnapshot
    invocation: HrcBrokerInvocationRecord
  }) => Promise<void> | void
}

export async function startController(
  ctx: DispatchContext,
  input: BrokerControllerStartInput
): Promise<BrokerControllerStartResult> {
  const startOptions: StdioTransportStartOptions = {
    command: ctx.brokerCommand,
    args: ctx.brokerArgs,
    env: compactEnv(ctx.env),
  }

  // Launch-timing instrumentation (diagnostic). The broker has no log of its
  // own — its stderr is swallowed into a tail buffer by the stdio transport and
  // only surfaced on a transport error. These phase durations are the broker's
  // first observable timing; they land in hrc-server.err.log via the server
  // logger so we can localize the cost of a real (non-dry-run) launch.
  const timingStartMs = performance.now()
  let phaseStartMs = timingStartMs
  const markPhase = (phase: string): void => {
    const nowMs = performance.now()
    ctx.logger.info?.('broker.timing', {
      phase,
      durMs: Number((nowMs - phaseStartMs).toFixed(1)),
      runtimeId: String(input.identity.runtimeId),
    })
    phaseStartMs = nowMs
  }

  let client: BrokerClientLike | undefined
  let tmuxAllocation: BrokerTmuxAllocation | undefined
  try {
    // T-01812 Phase 3 — for an interactive broker-tmux profile, allocate the
    // per-runtime btmux lease UP FRONT. A durable allocator launches a 'broker'
    // window over `--transport unix` and yields a broker IPC socket path we
    // DIAL (instead of spawning a stdio child); a legacy allocator yields no
    // IPC socket and we keep the stdio launch. Preflight already ran inside the
    // durable allocator BEFORE any tmux spawn.
    // T-01866 — headless durable cutover is now UNCONDITIONAL. There is no
    // escape hatch: HRC_HEADLESS_BROKER_LEGACY_STDIO has NO route authority, so
    // a stale env var can neither resurrect legacy v0.1/stdio nor create a
    // v0.2-over-stdio path. Every headless broker runtime allocates a leased-tmux
    // substrate (presentation='none') + Unix v0.2 IPC, exactly like the durable
    // interactive route. Durability truth still comes from the negotiated hello +
    // persisted substrate/endpoint, never from a compile-time marker or flag.
    if (input.brokerClient === undefined && isBrokerTmuxProfile(input.profile)) {
      tmuxAllocation = await allocateTmuxIfRequired(ctx.allocationContext(), input)
      markPhase('broker-tmux-alloc')
    } else if (input.brokerClient === undefined && input.profile.interactionMode === 'headless') {
      // Headless durable cutover (spec §10.4): allocate a leased-tmux substrate
      // with presentation='none' (broker window + Unix IPC + token + ledger, NO
      // TUI, NO operator attach) and DIAL it over Unix v0.2 instead of spawning
      // a stdio daemon-child. Public/API identity stays transport='headless'.
      tmuxAllocation = await allocateHeadlessSubstrate(ctx.allocationContext(), input)
      markPhase('broker-headless-substrate-alloc')
    }

    const durableSocketPath = tmuxAllocation?.brokerIpcSocketPath
    if (durableSocketPath) {
      client = await ctx.connectDurableBrokerWithRetry(
        durableSocketPath,
        String(input.identity.runtimeId)
      )
      markPhase('broker-connect-unix')
    } else {
      client = input.brokerClient ?? (await ctx.brokerClientFactory(startOptions))
      markPhase(input.brokerClient ? 'broker-client-ready' : 'broker-spawn')
    }
    client.onPermissionRequest((request) => ctx.handlePermissionRequest(request))

    const identity = input.identity
    client.onClose((error) => {
      ctx.handleBrokerClose(String(identity.runtimeId), error)
    })

    // T-01866 — HRC negotiates ONLY harness-broker/0.2. The durable route rides
    // the Unix socket (attach/replay required); the rare non-durable row keeps the
    // stdio transport kind but still expects v0.2, so any legacy v0.1 broker hello
    // is rejected (no v0.1 fallback, no v0.2-over-stdio masquerade).
    const expectedNegotiation: ExpectedBrokerNegotiation = durableSocketPath
      ? {
          protocolVersion: BROKER_PROTOCOL_VERSION,
          transport: BROKER_TRANSPORT_UNIX,
          control: { attachReplay: 'required' },
        }
      : { protocolVersion: BROKER_PROTOCOL_VERSION, transport: BROKER_TRANSPORT }
    const hello = await client.hello({
      clientInfo: { name: 'hrc-server' },
      protocolVersions: [expectedNegotiation.protocolVersion],
      capabilities: { permissionRequests: true },
    })
    markPhase('broker-hello')

    // T-01866 — reject any broker that selects a protocol other than
    // harness-broker/0.2 with a CLEAR unsupported-protocol failure, before the
    // general capability admission runs. A stale v0.1 broker (or any future
    // version HRC has not adopted) is fail-closed here, never silently accepted.
    if (hello.protocolVersion !== BROKER_PROTOCOL_VERSION) {
      const detail = {
        runtimeId: String(input.identity.runtimeId),
        brokerDriver: input.profile.brokerDriver,
        selectedProtocol: hello.protocolVersion,
        requiredProtocol: BROKER_PROTOCOL_VERSION,
        endpointKind: durableSocketPath ? BROKER_TRANSPORT_UNIX : BROKER_TRANSPORT,
      }
      ctx.logger.warn?.('harness broker selected unsupported protocol', detail)
      ctx.markBrokerClosing(String(input.identity.runtimeId), 'broker-protocol-unsupported')
      await client.close().catch(() => undefined)
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_protocol_unsupported',
          `harness broker selected unsupported protocol ${hello.protocolVersion}; HRC requires ${BROKER_PROTOCOL_VERSION}`,
          detail
        ),
      }
    }

    const admission = admitBrokerHello(input.profile, hello, expectedNegotiation)
    if (!admission.ok) {
      ctx.logger.warn?.('harness broker pre-start admission rejected', admission.detail)
      ctx.markBrokerClosing(String(identity.runtimeId), 'pre-start-admission-rejected')
      await client.close().catch(() => undefined)
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_admission_rejected',
          'broker hello/capability admission rejected the runtime',
          admission.detail
        ),
      }
    }

    // Capability preflight (advisory, fail-closed): the only overlay v1 ever
    // materializes is the conservative default, which is trivially a subset of
    // the route/profile lifecycle capabilities. This gate refuses to dispatch
    // an uncertified idle-ttl/recycle-child/safe-retry overlay. Broker dispatch
    // validation remains authoritative.
    preflightBrokerLifecyclePolicy(input.profile, input.lifecyclePolicy)

    if (tmuxAllocation === undefined) {
      tmuxAllocation = await allocateTmuxIfRequired(ctx.allocationContext(), input)
      markPhase('broker-tmux-alloc')
    }
    // T-01874 Ph3 — a headless durable runtime has presentation='none' and no
    // operator pane, so it dispatches NO runtime.terminalSurface (and no tmux
    // shim): the broker-window pane must never become a terminalSurface. Only
    // the interactive tmux-tui route carries the operator pane lease.
    const dispatchRuntime =
      tmuxAllocation !== undefined && input.profile.interactionMode === 'headless'
        ? undefined
        : toDispatchRuntime(tmuxAllocation)
    const persisted = persistStartGraph(ctx.persistenceContext(), input, hello, tmuxAllocation)
    if (input.attachBeforeInvocationStart && tmuxAllocation?.lease) {
      await ctx.pauseForAttachedInvocationStart({
        pending: input.attachBeforeInvocationStart,
        runtime: persisted.runtime,
        allocation: tmuxAllocation,
      })
      markPhase('broker-attached-launch-gate')
    }
    // The lifecycle overlay rides ONLY on the dispatch options envelope —
    // never on input.startRequest (INV-14.4 compiler closure).
    const startResult = input.lifecyclePolicy
      ? await client.startInvocationFromRequest(input.startRequest, {
          dispatchEnv: input.dispatchEnv,
          runtime: dispatchRuntime,
          lifecyclePolicy: input.lifecyclePolicy,
        })
      : await client.startInvocationFromRequest(
          input.startRequest,
          input.dispatchEnv,
          dispatchRuntime
        )
    // Encompasses the driver's start() (e.g. codex's load-bearing paste-readiness
    // sleep + launch-command paste), so this is usually the largest broker phase.
    markPhase('broker-invocation-start')
    ctx.logger.info?.('broker.timing', {
      phase: 'broker-start-total',
      durMs: Number((performance.now() - timingStartMs).toFixed(1)),
      runtimeId: String(input.identity.runtimeId),
    })

    const invocationAdmission = admitStartedInvocation(
      input.profile,
      hello,
      startResult.response.capabilities
    )
    if (!invocationAdmission.ok) {
      ctx.logger.warn?.(
        'harness broker post-start invocation admission rejected',
        invocationAdmission.detail
      )
      markStartedInvocationFailed(
        ctx.persistenceContext(),
        input,
        startResult.response,
        invocationAdmission.detail
      )
      ctx.markBrokerClosing(String(identity.runtimeId), 'post-start-admission-rejected')
      await client
        .dispose({ invocationId: startResult.invocationId as InvocationId })
        .catch(() => undefined)
      await client.close().catch(() => undefined)
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_invocation_admission_rejected',
          'broker effective invocation capabilities rejected the runtime',
          invocationAdmission.detail
        ),
      }
    }

    const now = ctx.now()
    const invocation = ctx.db.brokerInvocations.update(startResult.invocationId, {
      invocationState: startResult.response.state,
      capabilitiesJson: JSON.stringify(startResult.response.capabilities),
      updatedAt: now,
    })
    const runtime = ctx.db.runtimes.update(String(identity.runtimeId), {
      status: runtimeStatusFromInvocationState(startResult.response.state),
      activeInvocationId: startResult.invocationId,
      activeOperationId: String(identity.operationId),
      activeRunId: identity.runId !== undefined ? String(identity.runId) : undefined,
      lastActivityAt: now,
      runtimeStateJson: buildRuntimeStateJson(
        ctx.persistenceContext(),
        input,
        hello,
        startResult.response,
        now,
        tmuxAllocation
      ),
      updatedAt: now,
    })

    ctx.db.runtimeOperations.update(String(identity.operationId), {
      status: 'completed',
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      capabilityResolutionJson: JSON.stringify({
        brokerHello: hello.capabilities,
        invocation: startResult.response.capabilities,
        result: { status: 'compatible' },
      }),
    })

    ctx.setActive({
      runtimeId: String(identity.runtimeId),
      invocationId: startResult.invocationId,
      client,
      closing: false,
      // T-01855: cache the freshly negotiated inspection capabilities so
      // inspection RPCs can gate on what THIS broker advertises.
      inspection: hello.capabilities.inspection,
    })

    ctx.consumeEvents(String(identity.runtimeId), startResult.events)
    if (runtime && invocation) {
      await ctx.registerInvocation?.({ runtime, invocation })
    }

    return {
      ok: true,
      runtime: runtime ?? persisted.runtime,
      run: persisted.run,
      invocation: invocation ?? persisted.invocation,
      hello,
      startResponse: startResult.response,
    }
  } catch (error) {
    const controllerError = toControllerError('broker_start_failed', error)
    if (client) {
      ctx.markBrokerClosing(String(input.identity.runtimeId), 'broker-start-failed')
      await client.close().catch(() => undefined)
    }
    ctx.logger.error?.('harness broker start failed', {
      error: controllerError.message,
      code: controllerError.code,
    })
    return { ok: false, error: controllerError }
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

  const lastProjectedSeq = ctx.lastProjectedBrokerSeq(invocation.invocationId)
  try {
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
    const snapshot = await input.client.snapshot({
      invocationId: invocation.invocationId as InvocationId,
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

    let replayedThroughSeq = lastProjectedSeq
    let ackedThroughSeq = lastProjectedSeq
    for (const envelope of replay.events) {
      const result = ctx.mapper.apply(envelope)
      ctx.afterMappedEvent(runtime.runtimeId, envelope, result)
      replayedThroughSeq = Math.max(replayedThroughSeq, envelope.seq)
      const projected = ctx.db.brokerInvocationEvents.getByInvocationAndSeq(
        String(envelope.invocationId),
        envelope.seq
      )
      if (projected?.projectionStatus === 'applied') {
        ackedThroughSeq = Math.max(ackedThroughSeq, envelope.seq)
      }
    }

    if (ackedThroughSeq > 0) {
      const ack = await input.client.ackEvents({
        invocationId: invocation.invocationId as InvocationId,
        throughSeq: ackedThroughSeq,
        controllerInstanceId: ctx.serverInstanceId,
      })
      ackedThroughSeq = ack.ackedThroughSeq
    }

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
      lastActivityAt: now,
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
      updatedAt: now,
    })

    input.client.onClose((error) => {
      ctx.handleBrokerClose(runtime.runtimeId, error)
    })
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
    const controllerError =
      error instanceof BrokerInvocationEventConflictError
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
