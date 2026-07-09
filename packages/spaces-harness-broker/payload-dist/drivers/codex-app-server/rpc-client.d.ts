import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { JsonRpcId } from 'spaces-harness-broker-protocol';
export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: JsonRpcId;
    method: string;
    params?: unknown;
}
export interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}
export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: JsonRpcId;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
export declare class CodexRpcError extends Error {
    readonly code: number;
    readonly data?: unknown;
    constructor(code: number, message: string, data?: unknown);
}
interface RpcHandlers {
    onNotification?: ((message: JsonRpcNotification) => void) | undefined;
    onRequest?: ((message: JsonRpcRequest) => Promise<unknown>) | undefined;
    onMessage?: ((message: JsonRpcMessage) => void) | undefined;
    onError?: ((error: Error) => void) | undefined;
}
export declare class CodexRpcClient {
    private readonly proc;
    private nextId;
    private readonly pending;
    private closed;
    private readonly handlers;
    constructor(proc: ChildProcessWithoutNullStreams, handlers?: RpcHandlers);
    sendRequest<T = unknown>(method: string, params?: unknown): Promise<T>;
    sendNotification(method: string, params?: unknown): Promise<void>;
    close(error?: Error): void;
    private handleLine;
    private isResponse;
    private isRequest;
    private isNotification;
    private handleResponse;
    private handleRequest;
    private writeMessage;
    private handleError;
}
export {};
//# sourceMappingURL=rpc-client.d.ts.map