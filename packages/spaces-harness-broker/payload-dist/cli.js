import { existsSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { BrokerErrorCode, validateCommand, validateInvocationStartRequest, } from 'spaces-harness-broker-protocol';
import { createDefaultBroker } from './default-broker';
import { runClaudeHookBridgeCli, runClaudeHookDecisionBridgeCli, } from './drivers/claude-code-tmux/hook-bridge';
import { runCodexHookBridgeCli } from './drivers/codex-cli-tmux/hook-bridge';
import { runPiHookBridgeCli } from './drivers/pi-tui-tmux/hook-bridge';
import { BrokerError } from './errors';
import { createEventLedger } from './event-ledger';
import { createProtocolServer } from './protocol-server';
import { assertSocketPathWithinBudget } from './socket-path';
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    if (command === 'run') {
        const transportIdx = args.indexOf('--transport');
        const transport = transportIdx !== -1 ? args[transportIdx + 1] : undefined;
        if (transport === 'stdio') {
            await runStdio(args);
        }
        else if (transport === 'unix') {
            await runUnix(args);
        }
        else {
            process.stderr.write(`Unknown or missing transport: ${transport ?? '(none)'}\n`);
            process.exit(1);
        }
    }
    else if (command === 'drivers') {
        const json = args.includes('--json');
        const broker = createDefaultBroker();
        const hello = await broker.hello({
            clientInfo: { name: 'harness-broker-cli' },
            protocolVersions: ['harness-broker/0.2'],
        });
        if (json) {
            process.stdout.write(`${JSON.stringify(hello.drivers, null, 2)}\n`);
        }
        else {
            for (const driver of hello.drivers) {
                process.stdout.write(`${driver.kind}\t${driver.available ? 'available' : 'unavailable'}\n`);
            }
        }
    }
    else if (command === 'claude-hook') {
        await runClaudeHookBridgeCli(args.slice(1));
    }
    else if (command === 'claude-hook-decision') {
        await runClaudeHookDecisionBridgeCli(args.slice(1));
    }
    else if (command === 'codex-hook') {
        await runCodexHookBridgeCli(args.slice(1));
    }
    else if (command === 'pi-hook') {
        await runPiHookBridgeCli(args.slice(1));
    }
    else if (command === 'run-once') {
        await runOnce(args.slice(1));
    }
    else if (command === 'validate-start-request') {
        await validateStartRequestCommand(args.slice(1));
    }
    else {
        process.stderr.write(`Unknown command: ${command ?? '(none)'}\nUsage: harness-broker run --transport stdio\n`);
        process.exit(1);
    }
}
async function runStdio(args) {
    const observerSocketPath = readFlag(args, '--experimental-observer-socket') ??
        process.env['HARNESS_BROKER_OBSERVER_SOCKET'];
    const observerMode = readFlag(args, '--experimental-observer-mode') ??
        process.env['HARNESS_BROKER_OBSERVER_MODE'] ??
        'observe';
    if (observerSocketPath !== undefined && observerMode !== 'observe') {
        process.stderr.write(`Unsupported --experimental-observer-mode ${JSON.stringify(observerMode)}; only "observe" is implemented\n`);
        process.exit(1);
    }
    const server = createProtocolServer({
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
    });
    let observer;
    function emitEvent(event) {
        const notification = {
            jsonrpc: '2.0',
            method: 'invocation.event',
            params: event,
        };
        server.notify(notification);
        observer?.notify(event);
    }
    // Wire ask-client permission decisions to the broker→client request transport.
    const eventLedger = createEventLedger();
    const broker = createDefaultBroker(emitEvent, (params) => server.request('invocation.permission.request', params),
    // Stdio broker event replay is ephemeral and process-local: it backs
    // inspection reads only. The path-backed, controller-fenced durable ledger
    // remains exclusive to the unix transport.
    { eventLedger });
    if (observerSocketPath !== undefined) {
        observer = await startBrokerObserverSocket({ socketPath: observerSocketPath, broker });
    }
    registerBrokerMethods(server, broker, {
        experimentalObserverEnabled: observerSocketPath !== undefined,
    });
    void server.start();
    process.stdin.on('end', () => {
        setImmediate(() => {
            void Promise.all([server.close(), observer?.close()]).then(() => {
                process.exit(0);
            });
        });
    });
}
function validateParams(method, id, params) {
    validateCommand({ jsonrpc: '2.0', id, method, params });
}
/**
 * Register the read-only broker JSON-RPC methods (the observer surface). This is
 * a strict SUBSET of the full broker surface: it has no mutating methods. Both
 * the full registration and the observer-only registration share this set so the
 * read surface cannot silently drift between them.
 */
function registerReadMethods(server, broker) {
    server.register('broker.hello', async ({ id, method, params }) => {
        validateParams(method, id, params);
        return broker.hello(params);
    });
    server.register('broker.health', async ({ id, method, params }) => {
        validateParams(method, id, params);
        return broker.health((params ?? {}));
    });
    server.register('broker.listInvocations', async ({ id, method, params }) => {
        validateParams(method, id, (params ?? {}));
        return broker.listInvocations((params ?? {}));
    });
    server.register('invocation.status', async ({ id, method, params }) => {
        validateParams(method, id, params);
        return broker.status(params);
    });
    server.register('invocation.snapshot', async ({ id, method, params }) => {
        validateParams(method, id, params);
        return broker.snapshot(params);
    });
    server.register('invocation.eventsSince', async ({ id, method, params }) => {
        validateParams(method, id, params);
        return broker.eventsSince(params);
    });
}
/**
 * Register the v1 broker JSON-RPC methods on a protocol server. Shared by the
 * stdio and unix transport entry points so both expose identical surfaces.
 */
function registerBrokerMethods(server, broker, options = {}) {
    registerReadMethods(server, broker);
    server.register('invocation.start', async ({ id, method, params }) => {
        // validateCommand validates the full InvocationDispatchRequest envelope
        // (including dispatchEnv key-class + lockedEnv-shadow rules) before dispatch.
        validateParams(method, id, params);
        const dispatch = params;
        if (options.experimentalObserverEnabled === true &&
            dispatch.startRequest.spec.driver.kind !== 'codex-app-server') {
            throw new BrokerError(BrokerErrorCode.UnsupportedCapability, 'Experimental observer socket is only supported for codex-app-server invocations', {
                driverKind: dispatch.startRequest.spec.driver.kind,
            });
        }
        return broker.start(dispatch.startRequest, dispatch.dispatchEnv, dispatch.runtime, dispatch.lifecyclePolicy);
    });
    server.register('invocation.input', async ({ id, method, params }) => {
        validateParams(method, id, params);
        return broker.input(params);
    });
    server.register('invocation.interrupt', async ({ id, method, params }) => {
        validateParams(method, id, params);
        return broker.interrupt(params);
    });
    server.register('invocation.stop', async ({ id, method, params }) => {
        validateParams(method, id, params);
        return broker.stop(params);
    });
    server.register('invocation.dispose', async ({ id, method, params }) => {
        validateParams(method, id, params);
        return broker.dispose(params);
    });
}
/**
 * Observer-mode registration: the read-only subset only. Deliberately omits all
 * mutating methods (start/input/interrupt/stop/dispose).
 */
function registerBrokerObserverMethods(server, broker) {
    registerReadMethods(server, broker);
}
/**
 * Long-lived broker over a Unix domain socket. The broker process owns a single
 * `net.Server`; controllers connect and disconnect freely without terminating
 * it (the durability difference from the stdio child). Phase C1 adds the
 * durable event ledger, attach identity gate, latest-valid-attach-wins fencing,
 * and the eventsSince/ackEvents/snapshot replay surface.
 */
async function runUnix(args) {
    const socketPath = readFlag(args, '--socket');
    if (!socketPath) {
        process.stderr.write('Usage: harness-broker run --transport unix --socket <path>\n');
        process.exit(1);
    }
    const observerSocketPath = readFlag(args, '--experimental-observer-socket') ??
        process.env['HARNESS_BROKER_OBSERVER_SOCKET'];
    const observerMode = readFlag(args, '--experimental-observer-mode') ??
        process.env['HARNESS_BROKER_OBSERVER_MODE'] ??
        'observe';
    if (observerSocketPath !== undefined && observerMode !== 'observe') {
        process.stderr.write(`Unsupported --experimental-observer-mode ${JSON.stringify(observerMode)}; only "observe" is implemented\n`);
        process.exit(1);
    }
    // Hazard (a): refuse over-long socket paths up front with a readable error
    // instead of surfacing a low-level sockaddr_un bind failure.
    try {
        assertSocketPathWithinBudget(socketPath);
    }
    catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    }
    // Durability wiring (Phase C1): on-disk event ledger + attach identity gate.
    const ledgerPath = readFlag(args, '--event-ledger');
    const runtimeId = readFlag(args, '--runtime-id');
    const hostSessionId = readFlag(args, '--host-session-id');
    const generationRaw = readFlag(args, '--generation');
    const attachTokenFile = readFlag(args, '--attach-token-file');
    const eventLedger = ledgerPath !== undefined ? createEventLedger({ path: ledgerPath }) : undefined;
    let attachIdentity;
    if (runtimeId !== undefined &&
        hostSessionId !== undefined &&
        generationRaw !== undefined &&
        attachTokenFile !== undefined) {
        attachIdentity = {
            runtimeId,
            hostSessionId,
            generation: Number(generationRaw),
            attachToken: (await readFile(attachTokenFile, 'utf8')).trim(),
        };
    }
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    // Hazard (b): conservative stale-socket cleanup — only unlink a socket node
    // that NO live listener answers; never steal a socket a peer accepts.
    await reclaimStaleSocket(socketPath);
    // The live controller channel: the most recently connected — and ultimately
    // the attached/fenced — controller. Event notifications and broker→client
    // permission requests route here.
    let liveServer;
    // `liveSocket` is NOT vestigial despite never having its value dereferenced:
    // it is the cleanup identity key. Its sole read is the `liveSocket === socket`
    // guard in the connection handler's cleanup() below, which clears `liveServer`
    // ONLY when the closing socket is the current live one (a stale connection
    // closing after a newer one became live must not wipe the live target). It is
    // written in lockstep with `liveServer` (here on attach, and on each connect),
    // and tracks a DIFFERENT lifetime than `activeController` (which is set only on
    // a successful fenced attach), so it cannot be folded into the fencing record.
    let liveSocket;
    // Fencing gate: set on a successful attach; only this controller may ack.
    let activeController;
    let observer;
    function emitEvent(event) {
        observer?.notify(event);
        if (!liveServer)
            return;
        const notification = {
            jsonrpc: '2.0',
            method: 'invocation.event',
            params: event,
        };
        liveServer.notify(notification);
    }
    const broker = createDefaultBroker(emitEvent, (params) => {
        if (!liveServer) {
            return Promise.reject(new Error('No controller connected for permission request'));
        }
        return liveServer.request('invocation.permission.request', params);
    }, {
        advertisedTransports: ['stdio-jsonrpc-ndjson', 'unix-jsonrpc-ndjson'],
        advertiseAttachReplay: true,
        // brokerInstanceId intentionally omitted: createBroker defaults it to
        // `broker_${process.pid}`, computed in this same process (identical value).
        // T-01794 Phase D: runtime-scoped hook IPC dir derived from this durable
        // broker's --socket parent, so its tmux drivers bind per-invocation hook
        // sockets under it (never the global tmpdir socket two runtimes share).
        hookIpcDir: join(dirname(socketPath), 'hooks'),
        ...(eventLedger !== undefined ? { eventLedger } : {}),
        ...(attachIdentity !== undefined ? { attachIdentity } : {}),
    });
    if (observerSocketPath !== undefined) {
        observer = await startBrokerObserverSocket({ socketPath: observerSocketPath, broker });
    }
    // Send a terminal control error to the fenced controller, then close it. The
    // client transport surfaces `control.fenced` as a ControllerFenced close so a
    // subsequent ackEvents on the dead socket rejects with that code.
    function fenceController(prev) {
        try {
            prev.server.notify({
                jsonrpc: '2.0',
                method: 'control.fenced',
                params: {
                    code: BrokerErrorCode.ControllerFenced,
                    message: 'Controller fenced by a newer attach',
                },
            });
        }
        catch {
            // Best-effort: the socket may already be gone.
        }
        prev.socket.end();
    }
    async function handleAttach(params, server, socket) {
        // broker.attach validates identity/token/correlation and throws
        // AttachRejected on any mismatch — validate BEFORE fencing the incumbent.
        const response = await broker.attach(params);
        const previous = activeController;
        activeController = { server, socket, instanceId: params.controllerInstanceId };
        liveServer = server;
        liveSocket = socket;
        if (previous && previous.socket !== socket) {
            fenceController(previous);
        }
        return response;
    }
    async function handleAckEvents(params) {
        if (activeController && activeController.instanceId !== params.controllerInstanceId) {
            throw new BrokerError(BrokerErrorCode.ControllerFenced, 'Controller has been fenced by a newer attach', { controllerInstanceId: params.controllerInstanceId });
        }
        return broker.ackEvents(params);
    }
    function registerDurabilityMethods(server, socket) {
        server.register('broker.attach', async ({ params }) => handleAttach(params, server, socket));
        server.register('invocation.snapshot', async ({ params }) => broker.snapshot(params));
        server.register('invocation.eventsSince', async ({ params }) => broker.eventsSince(params));
        server.register('invocation.ackEvents', async ({ params }) => handleAckEvents(params));
        server.register('invocation.permission.respond', async ({ params }) => broker.permissionRespond(params));
    }
    const netServer = createServer((socket) => {
        const server = createProtocolServer({
            stdin: socket,
            stdout: socket,
            stderr: process.stderr,
        });
        registerBrokerMethods(server, broker, {
            experimentalObserverEnabled: observerSocketPath !== undefined,
        });
        registerDurabilityMethods(server, socket);
        void server.start();
        // Latest connection becomes the live notification target; a previously
        // attached controller is only fenced when a new controller attaches.
        liveServer = server;
        liveSocket = socket;
        const cleanup = () => {
            // Identity guard: only clear the live target when THIS connection's socket
            // is the current one. A stale connection closing after a newer one became
            // live must not wipe the live server.
            if (liveSocket === socket) {
                liveSocket = undefined;
                liveServer = undefined;
            }
            if (activeController && activeController.socket === socket) {
                activeController = undefined;
            }
            void server.close();
        };
        socket.once('close', cleanup);
        socket.once('error', cleanup);
    });
    const shutdown = () => {
        netServer.close();
        void Promise.all([observer?.close(), unlink(socketPath).catch(() => { })]).then(() => {
            process.exit(0);
        });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    netServer.on('error', (err) => {
        process.stderr.write(`Broker unix server error: ${err instanceof Error ? err.message : String(err)}\n`);
        void (observer?.close() ?? Promise.resolve()).finally(() => process.exit(1));
    });
    netServer.listen(socketPath);
}
async function startBrokerObserverSocket(options) {
    const { socketPath, broker } = options;
    assertSocketPathWithinBudget(socketPath);
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await reclaimStaleSocket(socketPath);
    const observers = new Set();
    const sockets = new Set();
    const netServer = createServer((socket) => {
        sockets.add(socket);
        const observer = createProtocolServer({
            stdin: socket,
            stdout: socket,
            stderr: process.stderr,
        });
        const client = {
            server: observer,
            subscriptions: new Map(),
        };
        const observerBroker = {
            ...broker,
            async eventsSince(req) {
                const subscription = { cursor: req.afterSeq, queued: [] };
                client.subscriptions.set(req.invocationId, subscription);
                try {
                    const response = await broker.eventsSince(req);
                    subscription.cursor = response.currentSeq;
                    setImmediate(() => {
                        const current = client.subscriptions.get(req.invocationId);
                        if (current !== subscription || current.queued === undefined)
                            return;
                        const queued = current.queued;
                        current.queued = undefined;
                        for (const event of queued) {
                            notifyObserverClient(client, event);
                        }
                    });
                    return response;
                }
                catch (err) {
                    client.subscriptions.delete(req.invocationId);
                    throw err;
                }
            },
        };
        registerBrokerObserverMethods(observer, observerBroker);
        observers.add(client);
        void observer.start();
        const cleanup = () => {
            sockets.delete(socket);
            observers.delete(client);
            void observer.close();
        };
        socket.once('close', cleanup);
        socket.once('error', cleanup);
    });
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            netServer.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            netServer.removeListener('error', onError);
            resolve();
        };
        netServer.once('error', onError);
        netServer.once('listening', onListening);
        netServer.listen(socketPath);
    });
    netServer.on('error', (err) => {
        process.stderr.write(`Broker observer socket error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    const unlinkSocket = () => unlink(socketPath).catch(() => { });
    const cleanupSocketOnExit = () => {
        if (existsSync(socketPath)) {
            try {
                unlinkSync(socketPath);
            }
            catch {
                // Best-effort cleanup only.
            }
        }
    };
    let closed = false;
    const close = () => new Promise((resolve) => {
        if (closed) {
            resolve();
            return;
        }
        closed = true;
        process.removeListener('exit', cleanupSocketOnExit);
        for (const observer of observers) {
            void observer.server.close();
        }
        observers.clear();
        for (const socket of sockets) {
            socket.end();
            socket.destroy();
        }
        sockets.clear();
        netServer.close(() => {
            void unlinkSocket().then(() => resolve());
        });
    });
    process.once('exit', cleanupSocketOnExit);
    return {
        notify(event) {
            for (const observer of observers) {
                notifyObserverClient(observer, event);
            }
        },
        close,
    };
}
function notifyObserverClient(client, event) {
    const subscription = client.subscriptions.get(event.invocationId);
    if (subscription === undefined || event.seq <= subscription.cursor)
        return;
    if (subscription.queued !== undefined) {
        subscription.queued.push(event);
        return;
    }
    const notification = {
        jsonrpc: '2.0',
        method: 'invocation.event',
        params: eventForObserverNotification(event),
    };
    client.server.notify(notification);
    subscription.cursor = event.seq;
}
function eventForObserverNotification(event) {
    if (event.type !== 'turn.completed')
        return event;
    const payload = event.payload;
    if (payload === null || typeof payload !== 'object')
        return event;
    const fields = payload;
    if (fields['result'] !== undefined || fields['finalOutput'] === undefined)
        return event;
    return {
        ...event,
        payload: {
            ...fields,
            result: fields['finalOutput'],
        },
    };
}
/** Probe an existing socket node and unlink it only if no live listener answers. */
async function reclaimStaleSocket(socketPath) {
    if (!existsSync(socketPath)) {
        return;
    }
    if (await probeSocketAlive(socketPath)) {
        process.stderr.write(`Broker socket already in use by a live listener: ${socketPath}\n`);
        process.exit(1);
    }
    await unlink(socketPath).catch(() => { });
}
function probeSocketAlive(socketPath) {
    return new Promise((resolve) => {
        const probe = connect({ path: socketPath });
        const done = (alive) => {
            probe.destroy();
            resolve(alive);
        };
        probe.once('connect', () => done(true));
        probe.once('error', () => done(false));
    });
}
async function runOnce(args) {
    let request;
    try {
        request = await loadStartRequest(args);
    }
    catch (err) {
        process.stderr.write(`${formatError(err)}\n`);
        process.exit(1);
    }
    let resolveTurnDone;
    const turnDone = new Promise((resolve) => {
        resolveTurnDone = resolve;
    });
    const broker = createDefaultBroker((event) => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        if (event.type === 'turn.completed' ||
            event.type === 'turn.failed' ||
            event.type === 'turn.interrupted') {
            resolveTurnDone?.();
        }
    });
    // Same path the BrokerClient drives: a single InvocationStartRequest with its
    // initialInput carries the first turn — no separate invocation.input call.
    const start = await broker.start(request);
    await turnDone;
    await broker.stop({
        invocationId: start.invocationId,
        reason: 'run-once complete',
        graceMs: request.spec.process.limits?.stopGraceMs ?? 500,
    });
    await broker.dispose({ invocationId: start.invocationId });
}
/**
 * Resolve a single InvocationStartRequest from CLI flags. `--start-request`
 * (the ASP compiler's output shape) is preferred; `--spec`/`--input` is kept
 * for backward compatibility and folded into the same request shape. The
 * request is validated before it reaches the broker.
 */
async function loadStartRequest(args) {
    const startRequestPath = readFlag(args, '--start-request');
    if (startRequestPath) {
        const raw = (await Bun.file(startRequestPath).json());
        return validateInvocationStartRequest(raw);
    }
    const specPath = readFlag(args, '--spec');
    const inputPath = readFlag(args, '--input');
    if (specPath && inputPath) {
        const spec = (await Bun.file(specPath).json());
        const initialInput = (await Bun.file(inputPath).json());
        return validateInvocationStartRequest({ spec, initialInput });
    }
    throw new Error('Usage: harness-broker run-once (--start-request start-request.json | --spec invocation.json --input input.json)');
}
async function validateStartRequestCommand(args) {
    const filePath = readFlag(args, '--file');
    if (!filePath) {
        process.stderr.write('Usage: harness-broker validate-start-request --file start-request.json\n');
        process.exit(1);
    }
    try {
        const raw = (await Bun.file(filePath).json());
        validateInvocationStartRequest(raw);
    }
    catch (err) {
        process.stderr.write(`${formatError(err)}\n`);
        process.exit(1);
    }
    process.stdout.write('valid\n');
}
function formatError(err) {
    if (err && typeof err === 'object' && 'issues' in err) {
        const message = err instanceof Error ? err.message : 'Validation failed';
        return `${message}\n${JSON.stringify(err.issues, null, 2)}`;
    }
    return err instanceof Error ? err.message : String(err);
}
function readFlag(args, flag) {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
}
void main();
//# sourceMappingURL=cli.js.map