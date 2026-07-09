import { createInterface } from 'node:readline';
export function framed(stdin = process.stdin, stdout = process.stdout) {
    const pending = [];
    const waiters = [];
    const rl = createInterface({ input: stdin });
    // Exit when stdin reaches EOF (parent broker closed the pipe / orphaned us).
    // Without this, fixtures that block forever keep a readline open over an
    // EOF'd stdin and busy-spin the Bun event loop at ~100% CPU as orphans.
    rl.on('close', () => {
        process.exit(0);
    });
    rl.on('line', (line) => {
        const frame = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter) {
            waiter(frame);
            return;
        }
        pending.push(frame);
    });
    function write(frame) {
        stdout.write(`${JSON.stringify(frame)}\n`);
    }
    return {
        async read() {
            const frame = pending.shift();
            if (frame) {
                return frame;
            }
            return new Promise((resolve) => waiters.push(resolve));
        },
        respond(request, result) {
            write({ jsonrpc: '2.0', id: request.id, result });
        },
        reject(request, code, message, data) {
            write({ jsonrpc: '2.0', id: request.id, error: { code, message, data } });
        },
        notify(method, params = {}) {
            write({ jsonrpc: '2.0', method, params });
        },
        close(code = 0) {
            process.exit(code);
        },
    };
}
export async function expectMethod(io, method) {
    const frame = await io.read();
    if (frame.method !== method) {
        throw new Error(`expected ${method}, got ${frame.method}`);
    }
    return frame;
}
export async function initializeAndReadThreadRequest(io, expectedThreadMethod) {
    const init = await expectMethod(io, 'initialize');
    io.respond(init, { protocolVersion: 'codex-app-server/v0' });
    await expectMethod(io, 'initialized');
    return expectMethod(io, expectedThreadMethod);
}
export function completeSimpleTurn(io, text = 'Done.') {
    io.notify('turn/started', { turnId: 'turn_1' });
    io.notify('item/started', {
        turnId: 'turn_1',
        item: { type: 'agentMessage', id: 'msg_1' },
    });
    io.notify('item/agentMessage/delta', {
        turnId: 'turn_1',
        id: 'msg_1',
        text,
    });
    io.notify('item/completed', {
        turnId: 'turn_1',
        item: {
            type: 'agentMessage',
            id: 'msg_1',
            content: [{ type: 'text', text }],
        },
    });
    io.notify('turn/completed', {
        turnId: 'turn_1',
        status: 'completed',
        finalOutput: text,
    });
}
//# sourceMappingURL=fake-codex-app-server.js.map