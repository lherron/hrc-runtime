import type { InputId, InvocationEventEnvelope, InvocationEventType, InvocationId, TurnId } from 'spaces-harness-broker-protocol';
export interface EventSequencerOptions {
    now: () => Date;
    correlation?: Record<string, string> | undefined;
}
export interface InvocationEventSequencer {
    next<TPayload>(invocationId: InvocationId, type: InvocationEventType, payload: TPayload, extra?: {
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
}
export declare function createInvocationEventSequencer(options: EventSequencerOptions): InvocationEventSequencer;
//# sourceMappingURL=events.d.ts.map