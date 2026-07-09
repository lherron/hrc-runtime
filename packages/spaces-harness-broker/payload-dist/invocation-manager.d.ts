import type { BrokerLifecyclePolicyOverlay, BrokerListInvocationsRequest, BrokerListInvocationsResponse, BrokerTerminalSurfaceReport, ClientCapabilities, ContinuationUpdate, HarnessInvocationSpec, InputId, InvocationCapabilities, InvocationDisposeRequest, InvocationDisposeResponse, InvocationEventEnvelope, InvocationId, InvocationInput, InvocationInputRequest, InvocationInputResponse, InvocationInspectionSummary, InvocationInterruptRequest, InvocationInterruptResponse, InvocationPermissionRespondRequest, InvocationPermissionRespondResponse, InvocationRuntimeContext, InvocationStartResponse, InvocationState, InvocationStatusResponse, InvocationStopRequest, InvocationStopResponse, PermissionDecision, PermissionRequestId, PermissionRequestParams, TurnId } from 'spaces-harness-broker-protocol';
import type { Driver } from './drivers/driver';
import type { InvocationEventSequencer } from './events';
import type { DispatchEnv } from './runtime/env';
type PermissionDecidedBy = 'policy' | 'user' | 'api' | 'timeout';
interface QueuedInput {
    inputId: InputId;
    input: InvocationInputWithId;
}
type InvocationInputWithId = InvocationInput & {
    inputId: InputId;
};
/** Per-invocation in-memory record of a resolved input disposition. */
interface InputDispositionRecord {
    /** Stable fingerprint of the request content + policy, keyed by inputId. */
    fingerprint: string;
    response: InvocationInputResponse;
}
/**
 * Broker-owned pending permission request (C2). The pending state is held in
 * the broker (NOT the JSON-RPC request promise), survives controller
 * disconnect, and is retained until `deadlineAt`. `settle` resolves it exactly
 * once — by client response, reconnect respond, or deadline expiry.
 */
interface PendingPermissionRecord {
    params: PermissionRequestParams;
    defaultDecision: 'allow' | 'deny';
    /** Absolute ISO-8601 deadline surfaced to reconnecting controllers. */
    deadlineAt: string;
    settle(decision: 'allow' | 'deny', decidedBy: PermissionDecidedBy): void;
}
/** In-memory record of how a permission request settled (idempotency surface). */
interface SettledPermissionRecord {
    decision: 'allow' | 'deny';
    /** True when settled by deadline expiry — a later respond is then "expired". */
    expired: boolean;
}
export interface Invocation {
    readonly invocationId: InvocationId;
    readonly spec: HarnessInvocationSpec;
    state: InvocationState;
    capabilities: InvocationCapabilities;
    driver: Driver;
    continuation?: ContinuationUpdate | undefined;
    terminalEmitted: boolean;
    /** True once invocation.disposed has been emitted — keeps it idempotent. */
    disposedEmitted: boolean;
    /** Manager-owned public status projection, driven by applyEventState. */
    currentTurnId?: TurnId | undefined;
    currentInputId?: InputId | undefined;
    childPid?: number | undefined;
    exitCode?: number | null | undefined;
    signal?: string | null | undefined;
    /** Time of the first projected event (invocation creation activity). */
    startedAt?: string | undefined;
    /** Time of the most recent projected event. */
    lastActivityAt?: string | undefined;
    /** Seq of the most recent projected event. */
    currentSeq?: number | undefined;
    /** Count of turns that reached turn.completed over the invocation's life. */
    turnsCompleted?: number | undefined;
    /** True once the graceful-exit invocation.summary has been pushed (idempotent). */
    summaryEmitted?: boolean | undefined;
    /** Active turn start time, projected from turn.started event.time. */
    currentTurnStartedAt?: string | undefined;
    /** Active turn attempt, projected from turn.started/turn.retry. */
    currentTurnAttempt?: number | undefined;
    /** Current harness generation, projected from harness.started/recovery. */
    currentHarnessGeneration?: number | undefined;
    /**
     * Full accepted lifecycle overlay retained at start so the lifecycle view can
     * report idleTtlMs/idleSince/computedRetireAt without reverse-engineering the
     * accepted-policy event (which only carries the modes).
     */
    lifecycleOverlay?: BrokerLifecyclePolicyOverlay | undefined;
    /** Terminal reason, projected from terminal events. */
    terminalReason?: string | undefined;
    /** Terminal surface facts, projected from terminal.surface.reported. */
    terminalSurface?: BrokerTerminalSurfaceReport | undefined;
    /** True once a driver-owned harness.started has been observed. */
    harnessStartedSeen?: boolean | undefined;
    /** Per-invocation FIFO queue of pending inputs. */
    pending: QueuedInput[];
    /** Self-clearing drain lock: set while a drain is in flight, cleared in .finally(). */
    drainPromise?: Promise<void> | undefined;
    /** Short write lock for terminal-immediate busy inputs. This is not a turn queue. */
    steerPromise?: Promise<void> | undefined;
    /** Monotonic counter for broker-assigned inputIds. */
    inputCounter: number;
    /**
     * In-memory idempotency ledger for client-provided inputIds. A duplicate
     * inputId with byte-identical content/policy replays the original response;
     * a duplicate inputId with differing content/policy is a conflict. Surfaced
     * in the durability snapshot. Broker-survives-HRC-restart only (not on disk).
     */
    inputDispositions: Map<string, InputDispositionRecord>;
    /**
     * Exactly-once `turn.started` bracket ledger (T-04846), keyed by turnId.
     * The broker GUARANTEES one `turn.started` per delivered input — it
     * synthesizes the bracket from `applyInputNow`'s returned turnId rather than
     * depending on a driver hook (e.g. Claude `UserPromptSubmit`) that may not
     * fire for an idle dispatch. Both the synthesized (`source:'broker-delivery'`)
     * path and any driver/hook-observed `turn.started` flow through `emit`, which
     * dedupes on this map so a turn is never double-opened. The stored envelope is
     * the first (winning) start, returned to callers on a suppressed duplicate.
     */
    startedTurns: Map<TurnId, InvocationEventEnvelope>;
    /**
     * Broker-owned pending permission requests, keyed by permissionRequestId.
     * Retained across controller disconnect until each request's absolute
     * deadline, and surfaced in the durability snapshot (C2). In-memory only.
     */
    pendingPermissions: Map<PermissionRequestId, PendingPermissionRecord>;
    /**
     * How already-settled permission requests resolved, keyed by
     * permissionRequestId. Backs idempotent/conflict/expired `permission.respond`.
     */
    settledPermissions: Map<PermissionRequestId, SettledPermissionRecord>;
}
export interface InvocationManagerOptions {
    sequencer: InvocationEventSequencer;
    onEvent: (event: InvocationEventEnvelope) => void;
    getClientCapabilities?: (() => ClientCapabilities) | undefined;
    /**
     * Broker→client permission request transport. When provided, drivers can ask
     * the connected client to decide a permission request via
     * `DriverContext.requestPermission`. Absent when no outbound request
     * transport is available.
     */
    onPermissionRequest?: ((params: PermissionRequestParams) => Promise<PermissionDecision>) | undefined;
    maxInputQueueDepth?: number | undefined;
    /** Clock for broker-owned permission deadlines. Defaults to wall-clock. */
    now?: (() => Date) | undefined;
}
/** Options for the shared inspection summary builder. */
export interface InspectionSummaryOptions {
    /**
     * When true the caller asked for a liveness view. This phase only advertises
     * cached liveness, so the summary returns projected facts with mode:'cached'
     * even under a probe request (it never pretends to actively probe).
     */
    probeLiveness?: boolean | undefined;
}
export interface InvocationManager {
    start(spec: HarnessInvocationSpec, driver: Driver, initialInput?: InvocationInput | undefined, dispatchEnv?: DispatchEnv | undefined, runtime?: InvocationRuntimeContext | undefined, lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined): Promise<InvocationStartResponse>;
    input(req: InvocationInputRequest): Promise<InvocationInputResponse>;
    interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>;
    stop(req: InvocationStopRequest): Promise<InvocationStopResponse>;
    status(invocationId: InvocationId, opts?: InspectionSummaryOptions): InvocationStatusResponse;
    dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse>;
    permissionRespond(req: InvocationPermissionRespondRequest): InvocationPermissionRespondResponse;
    get(invocationId: InvocationId): Invocation | undefined;
    /**
     * Shared inspection read-model builder. status(), snapshot/buildSnapshot, and
     * listInvocations all project through this single helper so their inspection
     * fields cannot drift.
     */
    buildInspectionSummary(invocationId: InvocationId, opts?: InspectionSummaryOptions): InvocationInspectionSummary;
    listInvocations(req: BrokerListInvocationsRequest): BrokerListInvocationsResponse;
    activeCount(): number;
}
export declare function createInvocationManager(options: InvocationManagerOptions): InvocationManager;
export {};
//# sourceMappingURL=invocation-manager.d.ts.map