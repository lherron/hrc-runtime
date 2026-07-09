import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, } from 'node:fs';
import { dirname } from 'node:path';
import { BrokerErrorCode } from 'spaces-harness-broker-protocol';
import { BrokerError } from './errors';
const DEFAULT_RETENTION_FLOOR = 0;
export function createEventLedger(options = {}) {
    const path = options.path;
    const eventsByInvocation = new Map();
    const ackedByInvocation = new Map();
    const floorByInvocation = new Map();
    if (path !== undefined) {
        mkdirSync(dirname(path), { recursive: true });
        loadExisting(path, eventsByInvocation);
    }
    function appendSync(event) {
        const invocationId = event.invocationId;
        const seq = event.seq;
        const bytes = stableJsonStringify(event);
        const bySeq = eventsByInvocation.get(invocationId) ?? new Map();
        const existing = bySeq.get(seq);
        if (existing !== undefined) {
            if (existing.bytes !== bytes) {
                throw new BrokerError(BrokerErrorCode.ResourceError, `Conflicting duplicate event for ${invocationId} seq ${seq}`, { invocationId, seq });
            }
            return { appended: false };
        }
        bySeq.set(seq, { event: structuredClone(event), bytes });
        eventsByInvocation.set(invocationId, bySeq);
        if (path !== undefined) {
            appendLine(path, `${bytes}\n`);
        }
        return { appended: true };
    }
    return {
        append(event) {
            try {
                return Promise.resolve(appendSync(event));
            }
            catch (error) {
                return Promise.reject(error);
            }
        },
        eventsSince(invocationId, afterSeq) {
            const floor = floorByInvocation.get(invocationId) ?? DEFAULT_RETENTION_FLOOR;
            if (afterSeq < floor) {
                return Promise.reject(new BrokerError(BrokerErrorCode.EventReplayUnavailable, `Event replay unavailable before retention floor ${floor}`, { invocationId, afterSeq, retentionFloorSeq: floor }));
            }
            const bySeq = eventsByInvocation.get(invocationId) ?? new Map();
            const events = [...bySeq.entries()]
                .filter(([seq]) => seq > afterSeq)
                .sort(([left], [right]) => left - right)
                .map(([, stored]) => structuredClone(stored.event));
            return Promise.resolve(events);
        },
        ackEvents(invocationId, throughSeq) {
            const previous = ackedByInvocation.get(invocationId) ?? DEFAULT_RETENTION_FLOOR;
            if (throughSeq < previous) {
                return Promise.reject(new BrokerError(BrokerErrorCode.EventReplayUnavailable, `Event ack cannot move backwards from ${previous} to ${throughSeq}`, { invocationId, previousAckedThroughSeq: previous, throughSeq }));
            }
            ackedByInvocation.set(invocationId, throughSeq);
            return Promise.resolve({ ackedThroughSeq: throughSeq });
        },
        retentionFloorSeq(invocationId) {
            return Promise.resolve(floorByInvocation.get(invocationId) ?? DEFAULT_RETENTION_FLOOR);
        },
        currentSeq(invocationId) {
            const bySeq = eventsByInvocation.get(invocationId);
            if (bySeq === undefined || bySeq.size === 0) {
                return 0;
            }
            return Math.max(...bySeq.keys());
        },
        prune(options) {
            const active = new Set(options.activeInvocationIds);
            for (const [invocationId, ackedThroughSeq] of ackedByInvocation.entries()) {
                if (active.has(invocationId)) {
                    continue;
                }
                const currentFloor = floorByInvocation.get(invocationId) ?? DEFAULT_RETENTION_FLOOR;
                if (ackedThroughSeq <= currentFloor) {
                    continue;
                }
                floorByInvocation.set(invocationId, ackedThroughSeq);
                const bySeq = eventsByInvocation.get(invocationId);
                if (bySeq !== undefined) {
                    for (const seq of bySeq.keys()) {
                        if (seq <= ackedThroughSeq) {
                            bySeq.delete(seq);
                        }
                    }
                }
            }
            if (path !== undefined) {
                rewriteLedger(path, eventsByInvocation);
            }
            return Promise.resolve();
        },
    };
}
function loadExisting(path, eventsByInvocation) {
    let raw = '';
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch {
        return;
    }
    for (const line of raw.split('\n')) {
        if (line.trim() === '') {
            continue;
        }
        const parsed = JSON.parse(line);
        const bytes = stableJsonStringify(parsed);
        const bySeq = eventsByInvocation.get(parsed.invocationId) ?? new Map();
        bySeq.set(parsed.seq, { event: parsed, bytes });
        eventsByInvocation.set(parsed.invocationId, bySeq);
    }
}
function appendLine(path, line) {
    const fd = openSync(path, 'a');
    try {
        writeFileSync(fd, line);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
function rewriteLedger(path, eventsByInvocation) {
    const tmp = `${path}.tmp`;
    const rows = [...eventsByInvocation.values()]
        .flatMap((bySeq) => [...bySeq.values()])
        .sort((left, right) => {
        const invocationOrder = left.event.invocationId.localeCompare(right.event.invocationId);
        return invocationOrder === 0 ? left.event.seq - right.event.seq : invocationOrder;
    })
        .map((stored) => stored.bytes);
    writeFileSync(tmp, rows.length === 0 ? '' : `${rows.join('\n')}\n`);
    const fd = openSync(tmp, 'r');
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    renameSync(tmp, path);
}
export function stableJsonStringify(value) {
    return JSON.stringify(sortJson(value));
}
function sortJson(value) {
    if (Array.isArray(value)) {
        return value.map((item) => sortJson(item));
    }
    if (value && typeof value === 'object') {
        const record = value;
        const sorted = {};
        for (const key of Object.keys(record).sort()) {
            const item = record[key];
            if (item !== undefined) {
                sorted[key] = sortJson(item);
            }
        }
        return sorted;
    }
    return value;
}
//# sourceMappingURL=event-ledger.js.map