import { BrokerErrorCode } from 'spaces-harness-broker-protocol';
import type { JsonRpcError } from 'spaces-harness-broker-protocol';
export declare class BrokerError extends Error {
    readonly code: BrokerErrorCode;
    readonly data?: unknown;
    constructor(code: BrokerErrorCode, message: string, data?: unknown);
}
export declare function toJsonRpcError(err: unknown): JsonRpcError;
export declare function fromJsonRpcError(error: JsonRpcError): BrokerError;
export declare function toInvalidParamsBrokerError(err: unknown): BrokerError | undefined;
export declare function timeoutError(message: string): BrokerError;
export declare function shutdownError(message: string): BrokerError;
//# sourceMappingURL=errors.d.ts.map