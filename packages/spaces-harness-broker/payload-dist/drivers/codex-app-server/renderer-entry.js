#!/usr/bin/env bun
/**
 * T-04906 / T-04909 Phase B — Codex app-server renderer entry process.
 *
 * Launched by the codex-app-server driver into the HRC-leased `tmux-tui` pane
 * (see {@link buildRendererLaunchCommand}). It connects to the broker's
 * read-only observer/broker socket, bootstraps from `invocation.eventsSince`,
 * subscribes to live `invocation.event` notifications, and projects them into
 * the pane via {@link createCodexAppServerRendererProjection}.
 *
 * This is a presentation/observation process ONLY: it issues no mutating broker
 * methods. The app-server JSON-RPC stdio child remains the authoritative
 * harness transport.
 */
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { NdjsonDecoder, encodeNdjsonFrame, } from 'spaces-harness-broker-protocol';
import { postEnvelope } from '../hook-bridge-transport';
import { createCodexAppServerRendererProjection, } from './renderer';
function parseArgs(argv) {
    const read = (flag) => {
        const index = argv.indexOf(flag);
        return index === -1 ? undefined : argv[index + 1];
    };
    const invocationId = read('--invocation-id');
    const observerSocketPath = read('--observer-socket');
    const controlSocketPath = read('--control-socket');
    const runtimeId = read('--runtime-id');
    if (invocationId === undefined ||
        observerSocketPath === undefined ||
        controlSocketPath === undefined) {
        throw new Error('codex-app-server renderer requires --invocation-id, --observer-socket, and --control-socket');
    }
    return {
        invocationId,
        observerSocketPath,
        controlSocketPath,
        ...(runtimeId !== undefined ? { runtimeId } : {}),
    };
}
/**
 * Connect to the broker observer/read socket and expose it as a
 * {@link RendererDurableReadSurface}: `eventsSince` issues the bootstrap request
 * and `observe` delivers live `invocation.event` notifications. NDJSON-framed
 * JSON-RPC, matching the broker's read-method transport.
 */
function connectReadSurface(socketPath) {
    const decoder = new NdjsonDecoder();
    const liveHandlers = new Set();
    const pending = new Map();
    let nextId = 1;
    const socket = connect(socketPath);
    socket.setEncoding('utf8');
    function dispatch(message) {
        if ('id' in message && message.id !== null && message.id !== undefined) {
            const id = Number(message.id);
            const waiter = pending.get(id);
            if (waiter === undefined)
                return;
            pending.delete(id);
            if ('error' in message && message.error !== undefined) {
                waiter.reject(message.error);
            }
            else {
                waiter.resolve(message.result);
            }
            return;
        }
        if ('method' in message && message.method === 'invocation.event') {
            // The broker/observer wire shape carries the envelope DIRECTLY as `params`
            // (see cli.ts emitEvent / notifyObserverClient and the aspc facade — all
            // four producers emit `params: <envelope>`). Read it directly; tolerate a
            // legacy `{ event }` wrapper defensively so either shape is accepted.
            const params = message.params;
            const event = params?.event ?? params;
            if (event !== undefined &&
                typeof event.seq === 'number' &&
                typeof event.invocationId === 'string') {
                for (const handler of liveHandlers)
                    handler(event);
            }
        }
    }
    socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
            if (frame.ok)
                dispatch(frame.value);
        }
    });
    function request(method, params) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve: resolve, reject });
            socket.write(encodeNdjsonFrame({ jsonrpc: '2.0', id, method, params }));
        });
    }
    return {
        surface: {
            eventsSince: (req) => request('invocation.eventsSince', req),
            observe: (handler) => {
                liveHandlers.add(handler);
                return { close: () => liveHandlers.delete(handler) };
            },
        },
        close: () => socket.destroy(),
    };
}
async function main() {
    const { invocationId, observerSocketPath, controlSocketPath, runtimeId } = parseArgs(process.argv.slice(2));
    const { surface, close } = connectReadSurface(observerSocketPath);
    // The renderer writes into a real tmux pane (a TTY): enable colour unless the
    // operator opted out via NO_COLOR, and wrap to the pane width.
    const color = process.env['NO_COLOR'] === undefined && process.stdout.isTTY === true;
    const projection = createCodexAppServerRendererProjection({
        invocationId,
        readSurface: surface,
        sink: (line) => process.stdout.write(`${line}\n`),
        color,
        ...(typeof process.stdout.columns === 'number' ? { width: process.stdout.columns } : {}),
    });
    await projection.start();
    let quitPosted = false;
    let exitPosted = false;
    async function postRendererExit(exitCode, signal) {
        if (quitPosted || exitPosted)
            return;
        exitPosted = true;
        await postEnvelope(controlSocketPath, {
            type: 'app-server-renderer.exited',
            invocationId,
            ...(runtimeId !== undefined ? { runtimeId } : {}),
            callbackSocket: controlSocketPath,
            exitCode,
            signal,
        }).catch(() => undefined);
    }
    createInterface({ input: process.stdin }).on('line', (line) => {
        if (line.trim() !== '/quit' || quitPosted)
            return;
        quitPosted = true;
        void (async () => {
            await postEnvelope(controlSocketPath, {
                type: 'app-server-renderer.quit',
                invocationId,
                ...(runtimeId !== undefined ? { runtimeId } : {}),
                callbackSocket: controlSocketPath,
                reason: 'prompt_input_exit',
            }).catch(() => undefined);
            projection.close();
            close();
            process.exit(0);
        })();
    });
    // Keep the process alive to stream live events into the pane until the pane
    // (or the broker connection) is torn down.
    process.on('SIGINT', () => {
        void postRendererExit(null, 'SIGINT');
        projection.close();
        close();
        process.exit(0);
    });
    process.on('beforeExit', (code) => {
        void postRendererExit(code, null);
    });
}
if (import.meta.main) {
    await main();
}
//# sourceMappingURL=renderer-entry.js.map