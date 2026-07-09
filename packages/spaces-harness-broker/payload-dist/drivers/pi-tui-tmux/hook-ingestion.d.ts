export type PiHookEnvelopeEnv = {
    invocationId: string;
    generation: number;
    callbackSocket: string;
    runtimeId?: string | undefined;
    turnId?: string | undefined;
};
export type PiTuiTmuxHookEnvelope = {
    invocationId: string;
    generation: number;
    callbackSocket: string;
    runtimeId?: string | undefined;
    turnId?: string | undefined;
    hookData: unknown;
};
export declare function buildPiHookEnvelopeFromEnv(hookData: unknown, env: Record<string, string | undefined>): PiTuiTmuxHookEnvelope;
//# sourceMappingURL=hook-ingestion.d.ts.map