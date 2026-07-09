import { CONSERVATIVE_LIFECYCLE_CAPABILITIES } from 'spaces-harness-broker-protocol';
/**
 * Static capability descriptor for the codex-app-server driver.
 *
 * Kept in its own module so the (immutable) capability surface is declared
 * separately from the driver's lifecycle/RPC logic. Internal-only — consumed
 * via the driver's `capabilities()` accessor.
 */
export const CODEX_CAPABILITIES = {
    input: {
        user: true,
        steer: false,
        appendContext: false,
        localImages: true,
        fileRefs: false,
        queue: true,
    },
    turns: {
        concurrency: 'single',
        interrupt: 'unsupported',
    },
    continuation: {
        supported: true,
        provider: 'codex',
        keyKind: 'thread',
    },
    events: {
        assistantDeltas: true,
        toolCalls: true,
        usage: true,
        diagnostics: true,
    },
    control: {
        stop: true,
        dispose: true,
    },
    finalResponse: {
        jsonSchema: true,
        perTurn: true,
        strict: true,
        parsedResult: false,
    },
    lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
};
//# sourceMappingURL=capabilities.js.map