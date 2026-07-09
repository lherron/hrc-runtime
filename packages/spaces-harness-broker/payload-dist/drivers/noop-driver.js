import { BrokerErrorCode, CONSERVATIVE_LIFECYCLE_CAPABILITIES, } from 'spaces-harness-broker-protocol';
import { BrokerError } from '../errors';
const NOOP_CAPABILITIES = {
    input: {
        user: true,
        steer: false,
        appendContext: false,
        localImages: false,
        fileRefs: false,
        queue: false,
    },
    turns: {
        concurrency: 'single',
        interrupt: 'unsupported',
    },
    continuation: {
        supported: false,
    },
    events: {
        assistantDeltas: false,
        toolCalls: false,
        usage: false,
        diagnostics: true,
    },
    control: {
        stop: true,
        dispose: true,
    },
    lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
};
export function createNoopDriver(options = {}) {
    const terminal = options.terminal ?? 'exited';
    let ctx;
    return {
        kind: 'noop-driver',
        version: '0.1.0',
        capabilities() {
            return NOOP_CAPABILITIES;
        },
        async start(_spec, driverCtx) {
            ctx = driverCtx;
            return { ok: true };
        },
        async applyInputNow(_input) {
            throw new BrokerError(BrokerErrorCode.UnsupportedCapability, 'noop-driver does not support input');
        },
        async interrupt(_req) {
            return { accepted: false, effect: 'unsupported', reason: 'noop-driver' };
        },
        async stop(_req) {
            void ctx;
            return { accepted: true, state: terminal === 'exited' ? 'exited' : 'failed' };
        },
        async dispose() {
            ctx = undefined;
        },
    };
}
//# sourceMappingURL=noop-driver.js.map