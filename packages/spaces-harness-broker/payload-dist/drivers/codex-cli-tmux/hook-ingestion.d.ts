export type CodexHookEnvelopeEnv = {
    invocationId: string;
    generation: number;
    callbackSocket?: string | undefined;
    runtimeId?: string | undefined;
    turnId?: string | undefined;
};
export type CodexHookEnvelope = {
    invocationId: string;
    generation: number;
    callbackSocket?: string | undefined;
    runtimeId?: string | undefined;
    turnId?: string | undefined;
    hookData: unknown;
};
export declare function buildCodexHookEnvelopeFromEnv(hookData: unknown, env: Record<string, string | undefined>): CodexHookEnvelope;
//# sourceMappingURL=hook-ingestion.d.ts.map