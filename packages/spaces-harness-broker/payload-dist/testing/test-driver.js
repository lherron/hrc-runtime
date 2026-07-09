import { BrokerErrorCode, CONSERVATIVE_LIFECYCLE_CAPABILITIES, } from 'spaces-harness-broker-protocol';
import { BrokerError } from '../errors';
const TEST_CAPABILITIES = {
    input: {
        user: true,
        steer: false,
        appendContext: false,
        localImages: false,
        fileRefs: false,
        queue: true,
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
export function createTestDriver(options = {}) {
    const failInputIds = new Set(options.failInputIds ?? []);
    const capabilities = {
        ...TEST_CAPABILITIES,
        input: {
            ...TEST_CAPABILITIES.input,
            ...options.inputCapabilities,
        },
    };
    const inputs = [];
    const steeredInputs = [];
    let ctx;
    let activeInput;
    let activeTurnId;
    let turnCounter = 0;
    const requireCtx = () => {
        if (ctx === undefined) {
            throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'test-driver is not started');
        }
        return ctx;
    };
    const requireActiveTurn = () => {
        if (activeInput === undefined || activeTurnId === undefined) {
            throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'No active test turn');
        }
        return { input: activeInput, turnId: activeTurnId };
    };
    const clearActiveTurn = () => {
        activeInput = undefined;
        activeTurnId = undefined;
    };
    const controller = {
        inputs,
        steeredInputs,
        get activeInput() {
            return activeInput;
        },
        get activeTurnId() {
            return activeTurnId;
        },
        completeActiveTurn(finalOutput = 'test turn complete') {
            const active = requireActiveTurn();
            clearActiveTurn();
            requireCtx().emit('turn.completed', { turnId: active.turnId, status: 'completed', finalOutput }, { turnId: active.turnId, inputId: active.input.inputId });
        },
        failActiveTurn(message = 'test turn failed') {
            const active = requireActiveTurn();
            clearActiveTurn();
            requireCtx().emit('turn.failed', { turnId: active.turnId, status: 'failed', message }, { turnId: active.turnId, inputId: active.input.inputId });
        },
        interruptActiveTurn(reason = 'test turn interrupted') {
            const active = requireActiveTurn();
            clearActiveTurn();
            requireCtx().emit('turn.interrupted', { turnId: active.turnId, status: 'interrupted', reason }, { turnId: active.turnId, inputId: active.input.inputId });
        },
        clearContinuation(reason) {
            requireCtx().emit('continuation.cleared', { reason });
        },
    };
    const driver = {
        kind: 'test-driver',
        version: '0.1.0',
        capabilities() {
            return capabilities;
        },
        async start(_spec, driverCtx) {
            ctx = driverCtx;
            return { ok: true };
        },
        async applyInputNow(input) {
            const inputId = input.inputId ?? `input_test_${inputs.length + 1}`;
            const resolved = { ...input, inputId };
            if (failInputIds.has(inputId)) {
                throw new BrokerError(BrokerErrorCode.InputRejected, `test-driver failed input ${inputId}`);
            }
            inputs.push(resolved);
            activeInput = resolved;
            turnCounter += 1;
            activeTurnId = `turn_test_${turnCounter}`;
            // Driver emits turn.started — broker owns input.accepted separately. When
            // suppressTurnStarted is set, the driver stays silent (no hook fired) and
            // relies on the broker's delivery-synthesized bracket (T-04846).
            if (options.suppressTurnStarted !== true) {
                requireCtx().emit('turn.started', { turnId: activeTurnId }, { turnId: activeTurnId, inputId });
            }
            return { turnId: activeTurnId };
        },
        async interrupt(_req) {
            if (activeTurnId === undefined) {
                return { accepted: false, effect: 'no_active_turn' };
            }
            controller.interruptActiveTurn('driver interrupt');
            return { accepted: true, effect: 'turn_interrupted' };
        },
        async stop(_req) {
            clearActiveTurn();
            return { accepted: true, state: 'exited' };
        },
        async dispose() {
            ctx = undefined;
            clearActiveTurn();
            inputs.length = 0;
        },
    };
    if (options.supportsSteer === true) {
        driver.applySteerNow = async (input) => {
            const inputId = input.inputId ?? `input_test_steer_${steeredInputs.length + 1}`;
            const resolved = { ...input, inputId };
            steeredInputs.push(resolved);
        };
    }
    return { driver, controller };
}
//# sourceMappingURL=test-driver.js.map