/**
 * Pure persistence helpers for HarnessBrokerController.
 *
 * Extracted verbatim from controller.ts as a mechanical move. These are the
 * controller's DB-write / runtime-state-build steps; they take an explicit
 * `PersistenceContext` (db + now + serverInstanceId) instead of `this`, so the
 * behavior is byte-for-byte identical at the call site. Nothing here is part of
 * the controller's public export surface.
 */

import { HrcErrorCode } from 'hrc-core'
import type {
  HrcBrokerInvocationRecord,
  HrcProvider,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { BrokerHelloResponse, InvocationStartResponse } from 'spaces-harness-broker-protocol'
import { canonicalLifecyclePolicyJson } from 'spaces-harness-broker-protocol'

import { BROKER_TRANSPORT } from '../constants'
import {
  extractRuntimeStateTmux,
  isBrokerTmuxProfile,
  runtimeHarness,
  runtimeStatusFromInvocationState,
  toBrokerTmuxJson,
  toRuntimeStateTmux,
} from '../runtime-state'
import { BrokerControllerError } from './errors'
import { USER_INITIATED_CONTINUATION_CLEAR_REASONS } from './internal'
import type { BrokerControllerStartInput, BrokerTmuxAllocation } from './types'

export type PersistenceContext = {
  db: HrcDatabase
  now: () => string
  serverInstanceId: string
}

export function persistStartGraph(
  ctx: PersistenceContext,
  input: BrokerControllerStartInput,
  hello: BrokerHelloResponse,
  tmuxAllocation: BrokerTmuxAllocation | undefined
): {
  session: HrcSessionRecord
  runtime: HrcRuntimeSnapshot
  run?: HrcRunRecord | undefined
  invocation: HrcBrokerInvocationRecord
} {
  const now = ctx.now()
  const identity = input.identity
  const session = ctx.db.sessions.getByHostSessionId(String(identity.hostSessionId))
  if (!session) {
    throw new BrokerControllerError(
      'broker_unknown_host_session',
      `host session not found: ${String(identity.hostSessionId)}`
    )
  }

  ctx.db.compiledRuntimePlans.insert({
    planHash: String(input.plan.planHash),
    compileId: String(input.plan.compileId),
    schemaVersion: input.plan.schemaVersion,
    compilerName: input.plan.compiler.name,
    compilerVersion: input.plan.compiler.version,
    planProjectionJson: JSON.stringify(input.plan),
    diagnosticsJson: JSON.stringify(input.plan.diagnostics ?? []),
    createdAt: input.plan.createdAt,
  })

  ctx.db.runtimeOperations.insert({
    operationId: String(identity.operationId),
    runtimeId: String(identity.runtimeId),
    ...(identity.runId !== undefined ? { runId: String(identity.runId) } : {}),
    hostSessionId: String(identity.hostSessionId),
    generation: identity.generation,
    operationKind: 'broker_invocation',
    controller: 'harness-broker',
    compileId: String(input.plan.compileId),
    planHash: String(input.plan.planHash),
    selectedProfileId: String(input.profile.profileId),
    selectedProfileHash: String(input.profile.profileHash),
    startupMethod: 'broker.startInvocationFromRequest',
    turnDelivery: 'invocation.input',
    status: 'starting',
    routeDecisionJson: JSON.stringify(input.routeDecision ?? { controller: 'harness-broker' }),
    capabilityResolutionJson: JSON.stringify({
      brokerHello: hello.capabilities,
      drivers: hello.drivers,
      result: { status: 'admitted' },
    }),
    createdAt: now,
    startedAt: now,
    updatedAt: now,
  })

  // T-01874 Ph3 — public/API transport tracks the PROFILE, not the substrate.
  // A headless durable runtime now carries a leased-tmux substrate
  // (`tmuxAllocation` set) but its identity stays transport='headless'
  // (presentation='none'); only the interactive tmux-tui profile is 'tmux'.
  const transport = tmuxAllocation && isBrokerTmuxProfile(input.profile) ? 'tmux' : 'headless'
  const runtime = ctx.db.runtimes.insert({
    runtimeId: String(identity.runtimeId),
    runtimeKind: 'harness',
    hostSessionId: String(identity.hostSessionId),
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: identity.generation,
    transport,
    harness: runtimeHarness(input.plan.harness.runtime),
    provider: input.plan.harness.provider as HrcProvider,
    status: 'starting',
    supportsInflightInput: true,
    adopted: false,
    ...(tmuxAllocation && isBrokerTmuxProfile(input.profile)
      ? {
          tmuxJson: toBrokerTmuxJson(input.profile.brokerDriver, tmuxAllocation),
        }
      : {}),
    ...(identity.runId !== undefined ? { activeRunId: String(identity.runId) } : {}),
    controllerKind: 'harness-broker',
    activeOperationId: String(identity.operationId),
    activeInvocationId: String(identity.invocationId),
    compileId: String(input.plan.compileId),
    planHash: String(input.plan.planHash),
    selectedProfileHash: String(input.profile.profileHash),
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: String(identity.runtimeId),
      hostSessionId: String(identity.hostSessionId),
      generation: identity.generation,
      status: 'starting',
      ...(tmuxAllocation && isBrokerTmuxProfile(input.profile)
        ? { tmux: toRuntimeStateTmux(input.profile.brokerDriver, tmuxAllocation) }
        : {}),
    },
    createdAt: now,
    updatedAt: now,
  })

  const run =
    identity.runId !== undefined
      ? ctx.db.runs.insert({
          runId: String(identity.runId),
          hostSessionId: String(identity.hostSessionId),
          runtimeId: String(identity.runtimeId),
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: identity.generation,
          transport,
          status: 'accepted',
          acceptedAt: now,
          updatedAt: now,
          operationId: String(identity.operationId),
          invocationId: String(identity.invocationId),
        })
      : undefined

  // Persist the dispatched lifecycle overlay as AUDIT material (never compiler
  // closure): record the canonical policy in lifecycle_policies and stamp the
  // invocation's lifecycle_policy_hash. WS-B owns the DDL; we only call it.
  if (input.lifecyclePolicy) {
    ctx.db.lifecyclePolicies.insert({
      policyId: input.lifecyclePolicy.policyId,
      lifecyclePolicyHash: input.lifecyclePolicy.policyHash,
      canonicalPolicyJson: canonicalLifecyclePolicyJson(input.lifecyclePolicy),
      schemaVersion: input.lifecyclePolicy.schemaVersion,
      createdAt: now,
    })
  }

  const invocation = ctx.db.brokerInvocations.insert({
    invocationId: String(identity.invocationId),
    operationId: String(identity.operationId),
    runtimeId: String(identity.runtimeId),
    ...(identity.runId !== undefined ? { runId: String(identity.runId) } : {}),
    // G1 (daedalus, T-01874 Ph3) — persist the protocol NEGOTIATED in
    // broker.hello, not a compile-time constant. Durable v0.2 rows must record
    // 'harness-broker/0.2' because that is what hello returned; legacy stdio
    // rows record whatever the stdio broker advertised. Stamping the constant
    // lied about the wire protocol for every durable runtime.
    brokerProtocol: hello.protocolVersion,
    brokerDriver: input.profile.brokerDriver,
    invocationState: 'starting',
    capabilitiesJson: JSON.stringify({}),
    specHash: input.specHash,
    startRequestHash: input.startRequestHash,
    selectedProfileHash: String(input.profile.profileHash),
    specProjectionJson: JSON.stringify(input.startRequest.spec),
    startRequestProjectionJson: JSON.stringify(input.startRequest),
    ownerServerInstanceId: ctx.serverInstanceId,
    ...(input.lifecyclePolicy ? { lifecyclePolicyHash: input.lifecyclePolicy.policyHash } : {}),
    createdAt: now,
    updatedAt: now,
  })

  return { session, runtime, run, invocation }
}

export function buildRuntimeStateJson(
  ctx: PersistenceContext,
  input: BrokerControllerStartInput,
  hello: BrokerHelloResponse,
  response: InvocationStartResponse,
  now: string,
  tmuxAllocation?: BrokerTmuxAllocation | undefined
): Record<string, unknown> {
  const identity = input.identity
  // T-01812 Phase 3 — durable broker identity persisted BEYOND pane ids: the
  // Unix endpoint + redacted attach-token ref, generation, broker command/pid,
  // and both named windows. The raw attach token is NEVER persisted.
  const durable = tmuxAllocation?.brokerIpcSocketPath
    ? {
        endpoint: {
          kind: 'unix-jsonrpc-ndjson' as const,
          socketPath: tmuxAllocation.brokerIpcSocketPath,
          ...(tmuxAllocation.attachTokenRef
            ? {
                attachTokenRef: {
                  kind: tmuxAllocation.attachTokenRef.kind,
                  path: tmuxAllocation.attachTokenRef.path,
                  redacted: true as const,
                },
              }
            : {}),
        },
        generation: tmuxAllocation.generation ?? identity.generation,
        ...(tmuxAllocation.brokerCommand ? { brokerCommand: tmuxAllocation.brokerCommand } : {}),
        ...(tmuxAllocation.brokerPid !== undefined ? { brokerPid: tmuxAllocation.brokerPid } : {}),
        ...(tmuxAllocation.brokerWindow ? { brokerWindow: tmuxAllocation.brokerWindow } : {}),
        ...(tmuxAllocation.tuiWindow ? { tuiWindow: tmuxAllocation.tuiWindow } : {}),
      }
    : { endpoint: { kind: BROKER_TRANSPORT } }
  return {
    schemaVersion: 'runtime-state/v1',
    kind: 'harness-broker',
    runtimeId: String(identity.runtimeId),
    hostSessionId: String(identity.hostSessionId),
    generation: identity.generation,
    status: runtimeStatusFromInvocationState(response.state),
    ...(identity.runId !== undefined ? { activeRunId: String(identity.runId) } : {}),
    createdAt: now,
    updatedAt: now,
    compile: {
      compileId: String(input.plan.compileId),
      planHash: String(input.plan.planHash),
      selectedProfileId: String(input.profile.profileId),
      selectedProfileHash: String(input.profile.profileHash),
      specHash: input.specHash,
      startRequestHash: input.startRequestHash,
    },
    broker: {
      protocolVersion: hello.protocolVersion,
      multiInvocation: hello.capabilities.multiInvocation,
      startedAt: now,
      ownerServerInstanceId: ctx.serverInstanceId,
      // T-01855: persist the negotiated inspection capabilities so a durable
      // reattach (which rebuilds `active` without a fresh hello) can rehydrate
      // them as a fallback until the next hello replaces them.
      ...(hello.capabilities.inspection ? { inspection: hello.capabilities.inspection } : {}),
      ...durable,
    },
    ...(tmuxAllocation?.brokerIpcSocketPath
      ? { control: { mode: 'broker-ipc', brokerAttached: true } }
      : {}),
    ...(isBrokerTmuxProfile(input.profile)
      ? {
          tmux: extractRuntimeStateTmux(
            ctx.db.runtimes.getByRuntimeId(String(identity.runtimeId))?.tmuxJson
          ),
        }
      : {}),
    invocation: {
      invocationId: response.invocationId,
      state: response.state,
      driver: input.profile.brokerDriver,
      harnessRuntime: input.plan.harness.runtime,
      capabilities: response.capabilities,
    },
    permission: {
      policy: input.profile.policy.permissionPolicy,
      negotiated: hello.capabilities.brokerToClientRequests,
      pending: [],
    },
    input: {
      policy: input.profile.policy.inputPolicy,
      pendingDepth: 0,
    },
  }
}

export function markStartedInvocationFailed(
  ctx: PersistenceContext,
  input: BrokerControllerStartInput,
  response: InvocationStartResponse,
  detail: Record<string, unknown>
): void {
  const now = ctx.now()
  const identity = input.identity
  const operationId = String(identity.operationId)
  const runtimeId = String(identity.runtimeId)
  const runId = identity.runId !== undefined ? String(identity.runId) : undefined
  const invocationId = response.invocationId
  const message = 'broker effective invocation capabilities rejected the runtime'

  ctx.db.brokerInvocations.update(invocationId, {
    invocationState: 'failed',
    capabilitiesJson: JSON.stringify(response.capabilities),
    updatedAt: now,
  })
  ctx.db.runtimeOperations.update(operationId, {
    status: 'failed',
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    errorCode: 'broker_invocation_admission_rejected',
    errorMessage: message,
    capabilityResolutionJson: JSON.stringify({
      brokerHello: detail['brokerCapabilities'],
      invocation: response.capabilities,
      result: { status: 'reject', missing: detail['missing'] },
    }),
  })
  if (runId !== undefined) {
    ctx.db.runs.markCompleted(runId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: message,
    })
  }
  ctx.db.runtimes.update(runtimeId, {
    status: 'failed',
    activeInvocationId: invocationId,
    activeOperationId: operationId,
    activeRunId: runId,
    lastActivityAt: now,
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId,
      hostSessionId: String(identity.hostSessionId),
      generation: identity.generation,
      status: 'failed',
      admissionFailure: detail,
      updatedAt: now,
    },
    updatedAt: now,
  })
}

export function findUserInitiatedContinuationClearReason(
  db: HrcDatabase,
  invocationId: string,
  beforeSeq: number
): string | undefined {
  const row = db.sqlite
    .query<{ reason: string | null }, [string, number]>(
      `SELECT json_extract(broker_event_json, '$.reason') AS reason
         FROM broker_invocation_events
        WHERE invocation_id = ? AND type = 'continuation.cleared' AND seq < ?
        ORDER BY seq DESC
        LIMIT 1`
    )
    .get(invocationId, beforeSeq)
  return row?.reason && USER_INITIATED_CONTINUATION_CLEAR_REASONS.has(row.reason)
    ? row.reason
    : undefined
}

/**
 * Latest continuation.cleared reason for a runtime's active invocation, when it
 * is a user-initiated /quit class reason. Runtime-scoped variant of
 * {@link findUserInitiatedContinuationClearReason} (which is invocation+seq
 * scoped) — used on the close path where there is no terminal envelope/seq.
 */
export function findUserInitiatedContinuationClearReasonForRuntime(
  db: HrcDatabase,
  runtimeId: string
): string | undefined {
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  const invocationId = runtime?.activeInvocationId
  if (invocationId === undefined) {
    return undefined
  }
  const row = db.sqlite
    .query<{ reason: string | null }, [string]>(
      `SELECT json_extract(broker_event_json, '$.reason') AS reason
         FROM broker_invocation_events
        WHERE invocation_id = ? AND type = 'continuation.cleared'
        ORDER BY seq DESC
        LIMIT 1`
    )
    .get(invocationId)
  return row?.reason && USER_INITIATED_CONTINUATION_CLEAR_REASONS.has(row.reason)
    ? row.reason
    : undefined
}
