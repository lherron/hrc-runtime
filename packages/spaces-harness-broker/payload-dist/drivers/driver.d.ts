import type { ClientCapabilities, HarnessInvocationSpec, InputId, InvocationCapabilities, InvocationEventEnvelope, InvocationEventType, InvocationId, InvocationInput, InvocationInterruptRequest, InvocationInterruptResponse, InvocationRuntimeContext, InvocationStopRequest, InvocationStopResponse, PermissionDecision, PermissionRequestParams, TurnId } from 'spaces-harness-broker-protocol';
import type { DispatchEnv } from '../runtime/env';
export interface ApplyInputResult {
    turnId?: TurnId | undefined;
}
export interface Driver {
    readonly kind: string;
    readonly version: string;
    capabilities(): InvocationCapabilities;
    start(spec: HarnessInvocationSpec, ctx: DriverContext): Promise<DriverStartResult>;
    applyInputNow(input: InvocationInput): Promise<ApplyInputResult>;
    applySteerNow?(input: InvocationInput): Promise<void>;
    interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>;
    stop(req: InvocationStopRequest): Promise<InvocationStopResponse>;
    dispose(): Promise<void>;
}
export interface DriverContext {
    invocationId: InvocationId;
    clientCapabilities: ClientCapabilities;
    /**
     * Per-invocation env from the `InvocationDispatchRequest` envelope (HRC-supplied,
     * not part of the hashed spec). The driver threads this into the spawn-env
     * composition (`spawnHarnessProcess`). Absent when no dispatchEnv was supplied.
     */
    dispatchEnv?: DispatchEnv | undefined;
    /**
     * Dispatch-time runtime overlay (spec §3.3) supplied by the HRC runtime
     * control plane — or the pre-HRC harness stand-in — AFTER profile selection.
     * Carries pre-allocated runtime resource handles: for terminal-host drivers
     * (Phase C/D) this is the `terminalSurface` pane lease the driver attaches
     * to. NOT part of the hashed spec. Absent when the route needs no runtime
     * handles. The legacy `tmux.socketPath` shape is still on the protocol
     * envelope for backward compatibility, but Phase C+ driver code reads ONLY
     * `terminalSurface`.
     */
    runtime?: InvocationRuntimeContext | undefined;
    emit<TPayload>(type: InvocationEventType, payload: TPayload, extra?: {
        turnId?: TurnId | undefined;
        inputId?: InputId | undefined;
        itemId?: string | undefined;
        driver?: {
            kind: string;
            rawType?: string | undefined;
        } | undefined;
        harnessGeneration?: number | undefined;
        turnAttempt?: number | undefined;
    }): InvocationEventEnvelope<TPayload>;
    /**
     * Ask the connected client to decide a permission request via the
     * broker→client JSON-RPC request transport. Provided only when the broker
     * has a transport that supports outbound requests (and, in production, when
     * the client negotiated `permissionRequests`). Absent for in-process callers
     * that have no client to ask.
     */
    requestPermission?(params: PermissionRequestParams): Promise<PermissionDecision>;
    /**
     * True when the broker owns the permission-request lifecycle (C2): pending
     * state is broker-held until an absolute deadline, survives controller
     * disconnect, and the broker emits `permission.resolved` and applies the
     * timeout default. In this mode the driver emits `permission.requested`, then
     * awaits {@link requestPermission} for the FINAL decision WITHOUT imposing its
     * own timeout or emitting `permission.resolved`. When false/absent (e.g. the
     * isolated driver unit harness) the driver owns the timeout and emits the
     * resolution itself.
     */
    brokerOwnsPermissionLifecycle?: boolean | undefined;
}
export interface DriverStartResult {
    ok: true;
}
//# sourceMappingURL=driver.d.ts.map