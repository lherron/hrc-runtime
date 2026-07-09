import { connect } from 'node:net';
/**
 * Shared transport mechanics for the broker-owned hook bridges (claude-code-tmux
 * and codex-cli-tmux). Both bridges read raw hook JSON on stdin, wrap it in a
 * driver-specific envelope (the builders legitimately diverge — Claude requires
 * a callbackSocket, Codex keeps it optional), and post the serialized envelope
 * to the broker callback unix socket.
 *
 * Only the transport is shared here; the envelope CONTRACT stays per-driver.
 */
/** Drain a readable stream to a UTF-8 string. */
export async function readAll(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}
/**
 * Parse the raw hook JSON. Empty stdin becomes an empty hook object; a non-JSON
 * payload is forwarded verbatim under `{ raw }` so the broker can diagnose it
 * rather than silently dropping the event.
 */
export function parseHookJson(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return {};
    }
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return { raw: trimmed };
    }
}
/** Connect to the broker callback socket and write the serialized envelope. */
export async function postEnvelope(socketPath, envelope) {
    await new Promise((resolve, reject) => {
        const conn = connect(socketPath);
        conn.on('error', reject);
        conn.on('connect', () => {
            conn.end(JSON.stringify(envelope));
        });
        conn.on('close', () => resolve());
    });
}
/** Connect to the broker callback socket, write an envelope, and read the response body. */
export async function postEnvelopeAndRead(socketPath, envelope, options = {}) {
    return await new Promise((resolve, reject) => {
        const chunks = [];
        let settled = false;
        const conn = connect(socketPath);
        const timeout = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            conn.destroy();
            resolve('');
        }, options.timeoutMs ?? 1000);
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            resolve(value);
        };
        conn.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
        });
        conn.on('data', (chunk) => chunks.push(chunk));
        conn.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        conn.on('close', () => finish(Buffer.concat(chunks).toString('utf8')));
        conn.on('connect', () => {
            conn.write(JSON.stringify(envelope));
        });
    });
}
/**
 * Shared CLI entrypoint for the hook bridges. Resolves `--socket <path>`,
 * exits(1) with a usage error if absent, otherwise runs the driver bridge and
 * swallows delivery errors (hooks are best-effort observability, not turn gates).
 */
export async function runHookBridgeCli(options) {
    const { commandName, args, run } = options;
    const socketIdx = args.indexOf('--socket');
    const socketPath = socketIdx !== -1 ? args[socketIdx + 1] : undefined;
    if (socketPath === undefined || socketPath.length === 0) {
        process.stderr.write(`${commandName} requires --socket <path>\n`);
        process.exit(1);
        return;
    }
    try {
        await run({ socketPath });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${commandName} delivery failed: ${message}\n`);
    }
}
//# sourceMappingURL=hook-bridge-transport.js.map