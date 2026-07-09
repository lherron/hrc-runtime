import { once } from 'node:events';
import { createInterface } from 'node:readline';
export class CodexRpcError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.name = 'CodexRpcError';
        this.code = code;
        this.data = data;
    }
}
export class CodexRpcClient {
    proc;
    nextId = 1;
    pending = new Map();
    closed = false;
    handlers;
    constructor(proc, handlers = {}) {
        this.proc = proc;
        this.handlers = handlers;
        const rl = createInterface({ input: proc.stdout });
        rl.on('line', (line) => {
            void this.handleLine(line);
        });
        proc.on('error', (error) => {
            this.handleError(error instanceof Error ? error : new Error(String(error)));
        });
        proc.on('exit', (code, signal) => {
            const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
            this.handleError(new Error(`Codex app-server exited with ${reason}`));
        });
    }
    async sendRequest(method, params) {
        const id = this.nextId++;
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            ...(params !== undefined ? { params } : {}),
        };
        const response = new Promise((resolve, reject) => {
            this.pending.set(id, {
                resolve: resolve,
                reject,
            });
        });
        await this.writeMessage(request);
        return response;
    }
    async sendNotification(method, params) {
        const notification = {
            jsonrpc: '2.0',
            method,
            ...(params !== undefined ? { params } : {}),
        };
        await this.writeMessage(notification);
    }
    close(error = new Error('JSON-RPC client is closed')) {
        if (this.closed)
            return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
        this.proc.stdin.end();
    }
    async handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        let message;
        try {
            message = JSON.parse(trimmed);
        }
        catch (error) {
            this.handleError(new Error(`Failed to parse JSON-RPC message: ${error instanceof Error ? error.message : String(error)}`));
            return;
        }
        this.handlers.onMessage?.(message);
        if (this.isResponse(message)) {
            this.handleResponse(message);
            return;
        }
        if (this.isRequest(message)) {
            await this.handleRequest(message);
            return;
        }
        if (this.isNotification(message)) {
            this.handlers.onNotification?.(message);
        }
    }
    isResponse(message) {
        return 'id' in message && !('method' in message);
    }
    isRequest(message) {
        return 'method' in message && 'id' in message;
    }
    isNotification(message) {
        return 'method' in message && !('id' in message);
    }
    handleResponse(message) {
        const pending = this.pending.get(message.id);
        if (!pending) {
            this.handleError(new Error(`Unexpected JSON-RPC response id: ${message.id}`));
            return;
        }
        this.pending.delete(message.id);
        if (message.error) {
            pending.reject(new CodexRpcError(message.error.code, message.error.message, message.error.data));
            return;
        }
        pending.resolve(message.result);
    }
    async handleRequest(message) {
        if (!this.handlers.onRequest) {
            await this.writeMessage({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: `Unhandled request: ${message.method}` },
            });
            return;
        }
        try {
            const result = await this.handlers.onRequest(message);
            await this.writeMessage({
                jsonrpc: '2.0',
                id: message.id,
                result,
            });
        }
        catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            await this.writeMessage({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32000, message: messageText },
            });
            this.handleError(error instanceof Error ? error : new Error(messageText));
        }
    }
    async writeMessage(message) {
        if (this.closed) {
            throw new Error('JSON-RPC client is closed');
        }
        const payload = `${JSON.stringify(message)}\n`;
        const wrote = this.proc.stdin.write(payload);
        if (!wrote) {
            await once(this.proc.stdin, 'drain');
        }
    }
    handleError(error) {
        if (this.closed)
            return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
        this.handlers.onError?.(error);
    }
}
//# sourceMappingURL=rpc-client.js.map