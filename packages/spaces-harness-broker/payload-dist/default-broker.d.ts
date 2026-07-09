import type { BrokerTransportKind, InvocationEventEnvelope, PermissionDecision, PermissionRequestParams } from 'spaces-harness-broker-protocol';
import { type BrokerAttachIdentity } from './broker';
import type { EventLedger } from './event-ledger';
export interface DefaultBrokerOptions {
    advertisedTransports?: BrokerTransportKind[] | undefined;
    advertiseAttachReplay?: boolean | undefined;
    eventLedger?: EventLedger | undefined;
    attachIdentity?: BrokerAttachIdentity | undefined;
    brokerInstanceId?: string | undefined;
    /**
     * Runtime-scoped IPC directory (the durable broker's `--socket` parent →
     * `hooks/`). When supplied, the tmux drivers bind per-invocation hook sockets
     * under it instead of the global `tmpdir()/harness-broker` default — so two
     * durable broker runtimes never collide on a shared hook socket (T-01794
     * Phase D). Absent for stdio / in-process callers, which keep the tmpdir
     * default.
     */
    hookIpcDir?: string | undefined;
}
export declare function createDefaultBroker(onEvent?: ((event: InvocationEventEnvelope) => void) | undefined, onPermissionRequest?: ((params: PermissionRequestParams) => Promise<PermissionDecision>) | undefined, options?: DefaultBrokerOptions): import("./broker").Broker;
//# sourceMappingURL=default-broker.d.ts.map