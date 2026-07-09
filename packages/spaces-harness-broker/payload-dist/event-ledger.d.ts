import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol';
export interface EventLedgerAppendResult {
    appended: boolean;
}
export interface EventLedgerAckResult {
    ackedThroughSeq: number;
}
export interface EventLedgerPruneOptions {
    activeInvocationIds: string[];
}
export interface EventLedger {
    append(event: InvocationEventEnvelope): Promise<EventLedgerAppendResult>;
    eventsSince(invocationId: InvocationId, afterSeq: number): Promise<InvocationEventEnvelope[]>;
    ackEvents(invocationId: InvocationId, throughSeq: number): Promise<EventLedgerAckResult>;
    retentionFloorSeq(invocationId: InvocationId): Promise<number>;
    currentSeq(invocationId: InvocationId): number;
    prune(options: EventLedgerPruneOptions): Promise<void>;
}
export interface EventLedgerOptions {
    path?: string | undefined;
}
export declare function createEventLedger(options?: EventLedgerOptions): EventLedger;
export declare function stableJsonStringify(value: unknown): string;
//# sourceMappingURL=event-ledger.d.ts.map