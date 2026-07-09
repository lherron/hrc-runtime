/** Stable driver identity stamped onto every event derived from a native notification. */
export const CODEX_DRIVER_KIND = 'codex-app-server';
const TOOL_NAMES = {
    commandExecution: 'command',
    fileChange: 'file_change',
    mcpToolCall: 'mcp_tool',
    webSearch: 'web_search',
    imageView: 'image_view',
};
const TOOL_TYPES = new Set(Object.keys(TOOL_NAMES));
const defaultHeldAssistantCompletions = new Map();
function asTurnId(value) {
    return value;
}
/**
 * Map a native Codex app-server notification to zero or more normalized broker
 * events. Every emitted event is stamped with `extra.driver` so consumers can
 * trace it back to the native method without that native type ever leaking into
 * the normalized `type`. Unknown native methods become a trace-level diagnostic
 * (again carrying `rawType`) rather than being silently dropped.
 */
export function mapCodexNotification(notification) {
    return mapCodexNotificationWithState(notification, defaultHeldAssistantCompletions);
}
export function createCodexNotificationMapper() {
    const heldAssistantCompletions = new Map();
    return (notification) => mapCodexNotificationWithState(notification, heldAssistantCompletions);
}
function mapCodexNotificationWithState(notification, heldAssistantCompletions) {
    const driver = { kind: CODEX_DRIVER_KIND, rawType: notification.method };
    return mapCodexNotificationInner(notification, heldAssistantCompletions).map((event) => ({
        ...event,
        extra: { ...event.extra, driver: event.extra?.driver ?? driver },
    }));
}
function mapCodexNotificationInner(notification, heldAssistantCompletions) {
    const params = asRecord(notification.params);
    switch (notification.method) {
        case 'turn/started': {
            const turnId = stringValue(params['turnId']) ?? stringValue(asRecord(params['turn'])['id']);
            if (!turnId)
                return [];
            heldAssistantCompletions.delete(turnId);
            return [
                {
                    type: 'turn.started',
                    payload: { turnId },
                    extra: { turnId: asTurnId(turnId) },
                },
            ];
        }
        case 'thread/tokenUsage/updated': {
            const usage = params['usage'] ?? params['tokenUsage'] ?? params['token_usage'];
            return [{ type: 'usage.updated', payload: { usage } }];
        }
        case 'item/started': {
            const turnId = stringValue(params['turnId']);
            const item = asRecord(params['item']);
            const itemType = stringValue(item['type']);
            const itemId = stringValue(item['id']);
            if (!turnId || !itemType || !itemId)
                return [];
            if (itemType === 'agentMessage') {
                return [
                    ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
                    {
                        type: 'assistant.message.started',
                        payload: { messageId: itemId },
                        extra: { turnId: asTurnId(turnId), itemId },
                    },
                ];
            }
            if (TOOL_TYPES.has(itemType)) {
                const input = normalizeToolInput(itemType, item);
                return [
                    ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
                    {
                        type: 'tool.call.started',
                        payload: {
                            toolCallId: itemId,
                            name: TOOL_NAMES[itemType] ?? itemType,
                            ...(input !== undefined ? { input } : {}),
                        },
                        extra: { turnId: asTurnId(turnId), itemId },
                    },
                ];
            }
            return [];
        }
        case 'item/agentMessage/delta': {
            const turnId = stringValue(params['turnId']);
            const itemId = stringValue(params['id']) ?? stringValue(params['itemId']);
            const text = stringValue(params['text']) ?? stringValue(params['delta']);
            if (!turnId || !itemId || text === undefined)
                return [];
            return [
                ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
                {
                    type: 'assistant.message.delta',
                    payload: { messageId: itemId, text },
                    extra: { turnId: asTurnId(turnId), itemId },
                },
            ];
        }
        case 'item/commandExecution/outputDelta':
        case 'item/fileChange/outputDelta': {
            const turnId = stringValue(params['turnId']);
            const itemId = stringValue(params['id']) ?? stringValue(params['itemId']);
            const text = stringValue(params['text']) ?? stringValue(params['delta']);
            if (!turnId || !itemId || text === undefined)
                return [];
            return [
                ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
                {
                    type: 'tool.call.delta',
                    payload: { toolCallId: itemId, text },
                    extra: { turnId: asTurnId(turnId), itemId },
                },
            ];
        }
        case 'item/mcpToolCall/progress': {
            const turnId = stringValue(params['turnId']);
            const itemId = stringValue(params['id']) ?? stringValue(params['itemId']);
            if (!turnId || !itemId)
                return [];
            return [
                ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
                {
                    type: 'tool.call.delta',
                    payload: {
                        toolCallId: itemId,
                        ...(params['data'] !== undefined ? { data: params['data'] } : { data: params }),
                    },
                    extra: { turnId: asTurnId(turnId), itemId },
                },
            ];
        }
        case 'item/completed': {
            const turnId = stringValue(params['turnId']);
            const item = asRecord(params['item']);
            const itemType = stringValue(item['type']);
            const itemId = stringValue(item['id']);
            if (!turnId || !itemType || !itemId)
                return [];
            if (itemType === 'agentMessage') {
                const previous = flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false);
                heldAssistantCompletions.set(turnId, assistantCompletionEvent(turnId, itemId, normalizeMessageContent(item), true));
                return previous;
            }
            if (TOOL_TYPES.has(itemType)) {
                const result = normalizeToolResult(itemType, item);
                const durationMs = numberValue(item['durationMs']);
                const isError = isToolError(itemType, item);
                return [
                    ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
                    {
                        type: isError ? 'tool.call.failed' : 'tool.call.completed',
                        payload: {
                            toolCallId: itemId,
                            name: stringValue(item['name']) ?? TOOL_NAMES[itemType] ?? itemType,
                            ...(result !== undefined ? { result } : {}),
                            isError,
                            ...(durationMs !== undefined ? { durationMs } : {}),
                        },
                        extra: { turnId: asTurnId(turnId), itemId },
                    },
                ];
            }
            return [];
        }
        case 'turn/completed': {
            const turn = asRecord(params['turn']);
            const turnId = stringValue(params['turnId']) ?? stringValue(turn['id']);
            if (!turnId)
                return [];
            const rawStatus = stringValue(params['status']) ?? stringValue(turn['status']);
            const status = rawStatus === 'failed'
                ? 'failed'
                : rawStatus === 'interrupted'
                    ? 'interrupted'
                    : 'completed';
            return [
                ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, true),
                {
                    type: status === 'failed'
                        ? 'turn.failed'
                        : status === 'interrupted'
                            ? 'turn.interrupted'
                            : 'turn.completed',
                    payload: {
                        turnId,
                        status,
                        ...(params['finalOutput'] !== undefined
                            ? { finalOutput: params['finalOutput'] }
                            : turn['finalOutput'] !== undefined
                                ? { finalOutput: turn['finalOutput'] }
                                : {}),
                    },
                    extra: { turnId: asTurnId(turnId) },
                },
            ];
        }
        default:
            // Unknown native notification: surface as a trace-level diagnostic so it
            // is observable but never leaks the native method name as a normalized
            // event `type`. The native method is preserved in `extra.driver.rawType`.
            return [
                {
                    type: 'diagnostic',
                    payload: {
                        level: 'debug',
                        message: `Unhandled Codex notification: ${notification.method}`,
                        source: 'driver',
                    },
                },
            ];
    }
}
function assistantCompletionEvent(turnId, itemId, content, final) {
    return {
        type: 'assistant.message.completed',
        payload: {
            messageId: itemId,
            content,
            final,
        },
        extra: {
            turnId: asTurnId(turnId),
            itemId,
            driver: { kind: CODEX_DRIVER_KIND, rawType: 'item/completed' },
        },
    };
}
function flushHeldAssistantCompletion(heldAssistantCompletions, turnId, final) {
    const held = heldAssistantCompletions.get(turnId);
    if (held === undefined)
        return [];
    heldAssistantCompletions.delete(turnId);
    return [
        {
            ...held,
            payload: { ...asRecord(held.payload), final },
        },
    ];
}
export function parseCodexError(params) {
    const root = asRecord(params);
    const nested = asRecord(root['error']);
    const message = stringValue(root['message']) ?? stringValue(nested['message']) ?? 'Codex app-server error';
    const code = stringValue(root['code']) ??
        stringValue(nested['code']) ??
        stringValue(asRecord(nested['codexErrorInfo'])['code']);
    const data = Object.keys(root).length > 0 ? root : undefined;
    return {
        message,
        ...(code !== undefined ? { code } : {}),
        ...(data !== undefined ? { data } : {}),
    };
}
function normalizeMessageContent(item) {
    const content = item['content'];
    if (Array.isArray(content)) {
        return content.flatMap((part) => {
            const record = asRecord(part);
            const text = stringValue(record['text']);
            return record['type'] === 'text' && text !== undefined
                ? [{ type: 'text', text }]
                : [];
        });
    }
    const text = stringValue(item['text']) ?? '';
    return [{ type: 'text', text }];
}
function normalizeToolInput(itemType, item) {
    const explicitInput = item['input'];
    switch (itemType) {
        case 'commandExecution':
            return (objectWithDefined({
                command: stringValue(item['command']),
                cwd: stringValue(item['cwd']),
            }) ?? explicitInput);
        case 'fileChange':
            return item['changes'] !== undefined ? { changes: item['changes'] } : explicitInput;
        case 'mcpToolCall':
            return (objectWithDefined({
                server: stringValue(item['server']),
                tool: stringValue(item['tool']),
                arguments: item['arguments'],
            }) ?? explicitInput);
        case 'webSearch':
            return objectWithDefined({ query: stringValue(item['query']) }) ?? explicitInput;
        case 'imageView':
            return objectWithDefined({ path: stringValue(item['path']) }) ?? explicitInput;
        default:
            return undefined;
    }
}
function normalizeToolResult(itemType, item) {
    const explicitResult = item['result'];
    switch (itemType) {
        case 'commandExecution':
            return (objectWithDefined({
                output: stringValue(item['aggregatedOutput']),
                exitCode: numberValue(item['exitCode']),
            }) ?? explicitResult);
        case 'fileChange':
            return item['changes'] !== undefined ? { changes: item['changes'] } : explicitResult;
        case 'mcpToolCall': {
            const error = item['error'];
            if (error !== undefined && error !== null) {
                return {
                    error,
                    ...(explicitResult !== null && explicitResult !== undefined
                        ? { result: explicitResult }
                        : {}),
                };
            }
            return explicitResult !== null && explicitResult !== undefined ? explicitResult : undefined;
        }
        case 'webSearch': {
            const query = stringValue(item['query']);
            return query !== undefined ? { query } : explicitResult;
        }
        case 'imageView': {
            const path = stringValue(item['path']);
            return path !== undefined ? { path } : explicitResult;
        }
        default:
            return undefined;
    }
}
function isToolError(itemType, item) {
    const status = stringValue(item['status']);
    if (status !== undefined && status !== 'completed')
        return true;
    switch (itemType) {
        case 'commandExecution': {
            const exitCode = numberValue(item['exitCode']);
            return exitCode !== undefined && exitCode !== 0;
        }
        case 'mcpToolCall': {
            const error = item['error'];
            return error !== undefined && error !== null;
        }
        case 'fileChange':
        case 'webSearch':
        case 'imageView':
            return false;
        default:
            return false;
    }
}
function objectWithDefined(values) {
    const result = {};
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
function asRecord(value) {
    return value !== null && typeof value === 'object' ? value : {};
}
function stringValue(value) {
    return typeof value === 'string' ? value : undefined;
}
function numberValue(value) {
    return typeof value === 'number' ? value : undefined;
}
//# sourceMappingURL=event-map.js.map