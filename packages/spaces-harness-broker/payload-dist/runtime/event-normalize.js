/**
 * Event normalization — the single central event-safety path applied by the
 * invocation manager before an event is sequenced and notified.
 *
 * This module is deliberately NOT a redaction subsystem. It performs two
 * non-secret safety transforms that the runtime contract requires of every
 * broker event:
 *
 *   (b) Well-known payload normalization — constrain `invocation.started` to
 *       its canonical safe shape and normalize the terminal `invocation.ready`
 *       / `invocation.disposed` payloads regardless of what the emitter passed.
 *   (c) Deterministic size bounding — truncate oversized payloads against
 *       `maxEventBytes`, emitting a broker diagnostic describing what was cut.
 *
 * Secret/token scrubbing was removed with the redaction subsystem: secrets
 * never enter event payloads in the first place (lockedEnv/dispatchEnv are not
 * echoed into events; credentials live on disk via CODEX_HOME).
 */
const TRUNCATED = '[TRUNCATED]';
/**
 * Constrain `invocation.started` payloads to only contain safe fields:
 * pid, command, args, cwd.
 */
export function safeStartedPayload(payload) {
    if (payload === null || typeof payload !== 'object')
        return payload;
    const p = payload;
    const safe = {};
    if (p['pid'] !== undefined)
        safe['pid'] = p['pid'];
    if (p['command'] !== undefined)
        safe['command'] = p['command'];
    if (p['args'] !== undefined)
        safe['args'] = startedArgsForPayload(p['args'], p['cwd']);
    if (p['cwd'] !== undefined)
        safe['cwd'] = p['cwd'];
    return safe;
}
function startedArgsForPayload(args, cwd) {
    if (!Array.isArray(args) || typeof cwd !== 'string' || cwd.length === 0)
        return args;
    if (!args.every((arg) => typeof arg === 'string'))
        return args;
    const exactArgs = [...args];
    Object.defineProperty(exactArgs, 'toJSON', {
        enumerable: false,
        value() {
            return exactArgs.map((arg) => serializeStartedArg(arg, cwd));
        },
    });
    return exactArgs;
}
function serializeStartedArg(arg, cwd) {
    const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
    if (arg === cwd)
        return '<cwd>';
    if (arg.startsWith(prefix))
        return `<cwd>/${arg.slice(prefix.length)}`;
    return arg;
}
/**
 * Normalize and size-bound an event payload before it is sequenced and emitted.
 * There is exactly one place that decides the canonical shape and the byte
 * budget of what leaves the broker:
 *
 * 1. Constrain `invocation.started` to {pid, command, args, cwd}.
 * 2. Normalize final-contract terminal payloads (`invocation.ready`,
 *    `invocation.disposed`) to their canonical shape regardless of emitter.
 * 3. Truncate oversized payloads deterministically against `maxEventBytes`,
 *    emitting a broker diagnostic describing what was truncated.
 *
 * Returns the safe payload plus any diagnostics the manager should emit as
 * follow-on events. Truncation is preferred over failing the invocation.
 */
export function normalizeEventPayload(input) {
    const { type, payload, maxEventBytes } = input;
    // 1 + 2. Constrain / normalize well-known payload shapes.
    let safe = payload;
    if (type === 'invocation.started') {
        safe = safeStartedPayload(payload);
    }
    else if (type === 'invocation.ready') {
        safe = { state: 'ready' };
    }
    else if (type === 'invocation.disposed') {
        safe = { disposed: true };
    }
    // 3. Deterministic size enforcement.
    if (maxEventBytes !== undefined && maxEventBytes > 0) {
        const result = truncateToBudget(safe, maxEventBytes);
        if (result.truncatedPaths.length > 0) {
            const diagnostic = {
                level: 'warn',
                message: `Event payload for ${type} exceeded maxEventBytes (${maxEventBytes}); truncated field(s): ${result.truncatedPaths.join(', ')}`,
                source: 'broker',
                data: {
                    eventType: type,
                    maxEventBytes,
                    truncatedFields: result.truncatedPaths,
                },
            };
            return { payload: result.payload, diagnostics: [diagnostic] };
        }
    }
    return { payload: safe };
}
function byteLength(value) {
    return Buffer.byteLength(value, 'utf8');
}
/**
 * Greedily replace the largest string leaves with `[TRUNCATED]` until the
 * serialized payload fits within `maxBytes`. Replacing a string with a shorter
 * string never invalidates other leaf paths, so candidates can be collected
 * once and applied in a stable (size desc, path asc) order — keeping the
 * behavior deterministic. If the payload cannot be serialized at all it is
 * replaced with a safe marker rather than crashing the broker.
 */
function truncateToBudget(payload, maxBytes) {
    let serialized;
    try {
        serialized = JSON.stringify(payload) ?? 'null';
    }
    catch {
        return {
            payload: { error: 'unserializable_payload', note: TRUNCATED },
            truncatedPaths: ['<payload>'],
        };
    }
    if (byteLength(serialized) <= maxBytes) {
        return { payload, truncatedPaths: [] };
    }
    const clone = JSON.parse(serialized);
    const leaves = [];
    collectStringLeaves(clone, [], leaves);
    leaves.sort((a, b) => b.len - a.len || a.path.join('.').localeCompare(b.path.join('.')));
    const truncatedPaths = [];
    for (const leaf of leaves) {
        setAtPath(clone, leaf.path, TRUNCATED);
        truncatedPaths.push(leaf.path.length > 0 ? leaf.path.join('.') : '<payload>');
        if (byteLength(JSON.stringify(clone) ?? 'null') <= maxBytes) {
            break;
        }
    }
    return { payload: clone, truncatedPaths };
}
function collectStringLeaves(value, path, out) {
    if (typeof value === 'string') {
        out.push({ path, len: value.length });
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectStringLeaves(item, [...path, String(index)], out));
        return;
    }
    if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            collectStringLeaves(child, [...path, key], out);
        }
    }
}
function setAtPath(root, path, replacement) {
    if (path.length === 0)
        return;
    let cursor = root;
    for (let i = 0; i < path.length - 1; i += 1) {
        cursor = cursor[path[i]];
    }
    cursor[path[path.length - 1]] = replacement;
}
//# sourceMappingURL=event-normalize.js.map