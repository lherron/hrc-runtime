import type { BrokerAttachRequest, BrokerAttachResponse, BrokerHealthRequest, BrokerHealthResponse, BrokerHelloRequest, BrokerHelloResponse, BrokerLifecyclePolicyOverlay, BrokerListInvocationsRequest, BrokerListInvocationsResponse, BrokerTransportKind, InvocationAckEventsRequest, InvocationAckEventsResponse, InvocationDisposeRequest, InvocationDisposeResponse, InvocationEventEnvelope, InvocationEventsSinceRequest, InvocationEventsSinceResponse, InvocationInputRequest, InvocationInputResponse, InvocationInterruptRequest, InvocationInterruptResponse, InvocationPermissionRespondRequest, InvocationPermissionRespondResponse, InvocationRuntimeContext, InvocationSnapshot, InvocationSnapshotRequest, InvocationStartRequest, InvocationStartResponse, InvocationStatusRequest, InvocationStatusResponse, InvocationStopRequest, InvocationStopResponse, PermissionDecision, PermissionRequestParams } from 'spaces-harness-broker-protocol';
import type { Driver } from './drivers/driver';
import type { EventLedger } from './event-ledger';
/**
 * Launch-time runtime identity a durable (unix) broker validates incoming
 * `broker.attach` requests against. Sourced from the broker's own CLI flags;
 * absent for stdio brokers (which never attach).
 */
export interface BrokerAttachIdentity {
    runtimeId: string;
    hostSessionId: string;
    generation: number;
    attachToken: string;
}
export interface BrokerOptions {
    drivers: Driver[];
    onEvent?: ((event: InvocationEventEnvelope) => void) | undefined;
    now?: (() => Date) | undefined;
    /**
     * Broker→client permission request transport (e.g. wired to
     * `ProtocolServer.request('invocation.permission.request', ...)`). When
     * present, ask-client permission policies can reach the connected client.
     */
    onPermissionRequest?: ((params: PermissionRequestParams) => Promise<PermissionDecision>) | undefined;
    maxInputQueueDepth?: number | undefined;
    /**
     * Transports this broker process advertises in `broker.hello`. Defaults to
     * stdio only; the unix server entry point advertises both stdio and unix.
     */
    advertisedTransports?: BrokerTransportKind[] | undefined;
    /**
     * Whether `broker.hello` advertises the attach/replay control surface. The
     * unix durable runtime advertises it; the stdio child does not.
     */
    advertiseAttachReplay?: boolean | undefined;
    /**
     * Durable event ledger. When present, every emitted event is persisted
     * (append idempotent by `(invocationId, seq)`) before the client is notified,
     * and the eventsSince/ackEvents/snapshot control surface serves from it.
     */
    eventLedger?: EventLedger | undefined;
    /**
     * Runtime identity that `broker.attach` validates incoming requests against.
     * Present only for the durable unix runtime.
     */
    attachIdentity?: BrokerAttachIdentity | undefined;
    /** Stable id reported in `broker.attach` responses. */
    brokerInstanceId?: string | undefined;
}
export interface Broker {
    hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse>;
    health(req: BrokerHealthRequest): Promise<BrokerHealthResponse>;
    start(req: InvocationStartRequest, dispatchEnv?: Record<string, string> | undefined, runtime?: InvocationRuntimeContext | undefined, lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined): Promise<InvocationStartResponse>;
    input(req: InvocationInputRequest): Promise<InvocationInputResponse>;
    interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>;
    stop(req: InvocationStopRequest): Promise<InvocationStopResponse>;
    status(req: InvocationStatusRequest): Promise<InvocationStatusResponse>;
    listInvocations(req: BrokerListInvocationsRequest): Promise<BrokerListInvocationsResponse>;
    dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse>;
    attach(req: BrokerAttachRequest): Promise<BrokerAttachResponse>;
    snapshot(req: InvocationSnapshotRequest): Promise<InvocationSnapshot>;
    eventsSince(req: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse>;
    ackEvents(req: InvocationAckEventsRequest): Promise<InvocationAckEventsResponse>;
    permissionRespond(req: InvocationPermissionRespondRequest): Promise<InvocationPermissionRespondResponse>;
}
export declare function createBroker(options: BrokerOptions): Broker;
//# sourceMappingURL=broker.d.ts.map