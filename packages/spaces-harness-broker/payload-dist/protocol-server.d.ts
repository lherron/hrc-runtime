import type { Readable, Writable } from 'node:stream';
import type { JsonRpcId, JsonRpcNotification } from 'spaces-harness-broker-protocol';
export type RequestHandler = (request: {
    id: JsonRpcId;
    method: string;
    params: unknown;
}) => Promise<unknown>;
export interface ProtocolServerOptions {
    stdin: Readable;
    stdout: Writable;
    stderr: Writable;
}
export interface ProtocolServerRequestOptions {
    timeoutMs?: number | undefined;
}
export interface ProtocolServer {
    register(method: string, handler: RequestHandler): void;
    start(): Promise<void>;
    request<T>(method: string, params: unknown, options?: ProtocolServerRequestOptions): Promise<T>;
    notify(notification: JsonRpcNotification): void;
    close(): Promise<void>;
}
export declare function createProtocolServer(options: ProtocolServerOptions): ProtocolServer;
//# sourceMappingURL=protocol-server.d.ts.map