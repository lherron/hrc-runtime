export function createInvocationEventSequencer(options) {
    const counters = new Map();
    const { now, correlation } = options;
    return {
        next(invocationId, type, payload, extra) {
            const current = counters.get(invocationId) ?? 0;
            const seq = current + 1;
            counters.set(invocationId, seq);
            const envelope = {
                invocationId,
                seq,
                time: now().toISOString(),
                type,
            };
            if (extra?.turnId !== undefined) {
                envelope.turnId = extra.turnId;
            }
            if (extra?.inputId !== undefined) {
                envelope.inputId = extra.inputId;
            }
            if (extra?.itemId !== undefined) {
                envelope.itemId = extra.itemId;
            }
            if (extra?.driver !== undefined) {
                envelope.driver = extra.driver;
            }
            if (extra?.harnessGeneration !== undefined) {
                envelope.harnessGeneration = extra.harnessGeneration;
            }
            if (extra?.turnAttempt !== undefined) {
                envelope.turnAttempt = extra.turnAttempt;
            }
            if (correlation !== undefined) {
                envelope.correlation = correlation;
            }
            envelope.payload = payload;
            return envelope;
        },
    };
}
//# sourceMappingURL=events.js.map