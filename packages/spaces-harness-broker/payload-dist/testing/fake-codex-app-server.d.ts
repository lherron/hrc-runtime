import type { Readable, Writable } from 'node:stream';
export interface JsonRpcRequestFrame {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: unknown;
}
export interface FakeCodexIo {
    read(): Promise<JsonRpcRequestFrame>;
    respond(request: JsonRpcRequestFrame, result: unknown): void;
    reject(request: JsonRpcRequestFrame, code: number, message: string, data?: unknown): void;
    notify(method: string, params?: unknown): void;
    close(code?: number): never;
}
export declare function framed(stdin?: Readable, stdout?: Writable): FakeCodexIo;
export declare function expectMethod(io: FakeCodexIo, method: string): Promise<JsonRpcRequestFrame>;
export declare function initializeAndReadThreadRequest(io: FakeCodexIo, expectedThreadMethod: 'thread/start' | 'thread/resume'): Promise<JsonRpcRequestFrame>;
export declare function completeSimpleTurn(io: FakeCodexIo, text?: string): void;
//# sourceMappingURL=fake-codex-app-server.d.ts.map