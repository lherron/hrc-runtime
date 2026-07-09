import { NdjsonDecoder, createJsonRpcErrorResponse, encodeNdjsonFrame, isJsonRpcRequest, isJsonRpcResponse, } from 'spaces-harness-broker-protocol';
import { fromJsonRpcError, shutdownError, timeoutError, toJsonRpcError } from './errors';
export function createProtocolServer(options) {
    const { stdin, stdout } = options;
    const handlers = new Map();
    const pendingRequests = new Map();
    const decoder = new NdjsonDecoder();
    let closed = false;
    let nextRequestId = 1;
    // Robustness bound (refactor A9): a peer streaming non-NDJSON bytes would
    // otherwise produce one parse-error frame per malformed line with no cap,
    // amplifying a single bad chunk into unbounded writes. We stop emitting
    // parse-error frames once this many parse errors arrive without any
    // intervening well-formed frame; any successfully decoded frame resets the
    // run. Well-formed traffic is unaffected.
    const MAX_CONSECUTIVE_PARSE_ERRORS = 64;
    let consecutiveParseErrors = 0;
    function writeFrame(message) {
        if (closed)
            return;
        stdout.write(encodeNdjsonFrame(message));
    }
    function settlePending(id, settle) {
        const pending = pendingRequests.get(id);
        if (!pending)
            return;
        pendingRequests.delete(id);
        if (pending.timer !== undefined) {
            clearTimeout(pending.timer);
        }
        settle(pending);
    }
    function rejectAllPending(reason) {
        for (const id of pendingRequests.keys()) {
            settlePending(id, (pending) => pending.reject(reason));
        }
    }
    function handleLine(frame) {
        if (isJsonRpcResponse(frame)) {
            settlePending(frame.id, (pending) => {
                if ('error' in frame) {
                    pending.reject(fromJsonRpcError(frame.error));
                }
                else {
                    pending.resolve(frame.result);
                }
            });
            return;
        }
        if (!isJsonRpcRequest(frame)) {
            // Client-side notifications have no response path in the broker protocol.
            return;
        }
        const handler = handlers.get(frame.method);
        if (!handler) {
            writeFrame(createJsonRpcErrorResponse(frame.id, -32601, `Method not found: ${frame.method}`));
            return;
        }
        // Fire-and-forget (async handler)
        void handler({ id: frame.id, method: frame.method, params: frame.params }).then((result) => {
            writeFrame({
                jsonrpc: '2.0',
                id: frame.id,
                result,
            });
        }, (err) => {
            const rpcError = toJsonRpcError(err);
            writeFrame({
                jsonrpc: '2.0',
                id: frame.id,
                error: rpcError,
            });
        });
    }
    function onData(chunk) {
        const results = decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        for (const result of results) {
            if (result.ok) {
                // A well-formed frame ends any run of parse errors.
                consecutiveParseErrors = 0;
                handleLine(result.value);
            }
            else {
                // Malformed frame: respond with parse error (id = null per JSON-RPC),
                // but cap the reply rate so a stream of garbage can't amplify into
                // unbounded writes (refactor A9). Once the cap is reached we silently
                // drop further parse-error frames until a valid frame resets the run.
                consecutiveParseErrors += 1;
                if (consecutiveParseErrors <= MAX_CONSECUTIVE_PARSE_ERRORS) {
                    writeFrame(createJsonRpcErrorResponse(null, -32700, 'Parse error'));
                }
            }
        }
    }
    return {
        register(method, handler) {
            handlers.set(method, handler);
        },
        async start() {
            stdin.on('data', onData);
            stdin.on('end', () => {
                // Flush remaining buffer
                const remaining = decoder.flush();
                for (const result of remaining) {
                    if (result.ok) {
                        handleLine(result.value);
                    }
                }
            });
        },
        notify(notification) {
            writeFrame(notification);
        },
        request(method, params, options = {}) {
            if (closed) {
                return Promise.reject(shutdownError('Protocol server is closed'));
            }
            const id = `broker_req_${nextRequestId++}`;
            return new Promise((resolve, reject) => {
                const pending = {
                    resolve: (value) => resolve(value),
                    reject,
                };
                if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
                    pending.timer = setTimeout(() => {
                        settlePending(id, (timedOut) => {
                            timedOut.reject(timeoutError(`Request timed out: ${method}`));
                        });
                    }, options.timeoutMs);
                }
                pendingRequests.set(id, pending);
                writeFrame({
                    jsonrpc: '2.0',
                    id,
                    method,
                    params,
                });
            });
        },
        async close() {
            closed = true;
            stdin.removeListener('data', onData);
            rejectAllPending(shutdownError('Protocol server is closed'));
        },
    };
}
//# sourceMappingURL=protocol-server.js.map