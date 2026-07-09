export type HookEnvelopeEnv = {
    invocationId: string;
    generation: number;
    callbackSocket: string;
    runtimeId?: string | undefined;
    turnId?: string | undefined;
};
export type HookEnvelope = {
    invocationId: string;
    generation: number;
    callbackSocket: string;
    runtimeId?: string | undefined;
    turnId?: string | undefined;
    hookData: unknown;
};
export declare function buildHookEnvelopeFromEnv(hookData: unknown, env: Record<string, string | undefined>): HookEnvelope;
//# sourceMappingURL=hook-ingestion.d.ts.map