import type { InputId, InvocationEventType, TurnId } from 'spaces-harness-broker-protocol';
import type { JsonRpcNotification } from './rpc-client';
export interface MappedEvent {
    type: InvocationEventType;
    payload: unknown;
    extra?: {
        turnId?: TurnId | undefined;
        inputId?: InputId | undefined;
        itemId?: string | undefined;
        driver?: {
            kind: string;
            rawType?: string | undefined;
        } | undefined;
    };
}
export interface CodexErrorInfo {
    message: string;
    code?: string | undefined;
    data?: unknown;
}
/** Stable driver identity stamped onto every event derived from a native notification. */
export declare const CODEX_DRIVER_KIND = "codex-app-server";
/**
 * Map a native Codex app-server notification to zero or more normalized broker
 * events. Every emitted event is stamped with `extra.driver` so consumers can
 * trace it back to the native method without that native type ever leaking into
 * the normalized `type`. Unknown native methods become a trace-level diagnostic
 * (again carrying `rawType`) rather than being silently dropped.
 */
export declare function mapCodexNotification(notification: JsonRpcNotification): MappedEvent[];
export declare function createCodexNotificationMapper(): (notification: JsonRpcNotification) => MappedEvent[];
export declare function parseCodexError(params: unknown): CodexErrorInfo;
//# sourceMappingURL=event-map.d.ts.map