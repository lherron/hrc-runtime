import { BrokerErrorCode, createJsonRpcError } from 'spaces-harness-broker-protocol';
export class BrokerError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.name = 'BrokerError';
        this.code = code;
        this.data = data;
    }
}
export function toJsonRpcError(err) {
    if (err instanceof BrokerError) {
        return createJsonRpcError(err.code, err.message, err.data);
    }
    if (isProtocolValidationError(err)) {
        return createJsonRpcError(-32602, 'Invalid params', { issues: err.issues });
    }
    if (err instanceof Error) {
        return createJsonRpcError(-32603, err.message);
    }
    return createJsonRpcError(-32603, 'Internal error');
}
export function fromJsonRpcError(error) {
    return new BrokerError(error.code, error.message, error.data);
}
export function toInvalidParamsBrokerError(err) {
    if (!isProtocolValidationError(err)) {
        return undefined;
    }
    return new BrokerError(-32602, 'Invalid params', { issues: err.issues });
}
export function timeoutError(message) {
    return new BrokerError(BrokerErrorCode.Timeout, message);
}
export function shutdownError(message) {
    return new BrokerError(BrokerErrorCode.ShutdownInProgress, message);
}
function isProtocolValidationError(err) {
    if (!(err instanceof Error) || typeof err !== 'object' || err === null) {
        return false;
    }
    const maybeValidationError = err;
    return (typeof maybeValidationError.code === 'string' &&
        maybeValidationError.code.startsWith('INVALID_') &&
        Array.isArray(maybeValidationError.issues) &&
        maybeValidationError.issues.every((issue) => typeof issue === 'object' &&
            issue !== null &&
            typeof issue.path === 'string' &&
            typeof issue.code === 'string' &&
            typeof issue.message === 'string'));
}
//# sourceMappingURL=errors.js.map