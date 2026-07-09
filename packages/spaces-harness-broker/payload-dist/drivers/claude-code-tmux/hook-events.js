import { createInvocationEventSequencer } from '../../events';
import { asRecord as asHookRecord, getNumber, getString, unwrapHookPayload } from '../hook-json';
import { USER_INITIATED_END_REASONS } from '../tmux-shared';
export const CLAUDE_CODE_TMUX_DRIVER_KIND = 'claude-code-tmux';
/**
 * Normalize a single hook envelope into broker events, using the ENVELOPE turn
 * id (cody's Phase 3 seam) when the raw hook payload omits `turn_id`.
 */
export function normalizeHookEnvelope(envelope, options = {}) {
    const normalizer = options.normalizer ??
        createClaudeCodeHookEventNormalizer({
            invocationId: envelope.invocationId,
            now: options.now ?? (() => new Date()),
        });
    const hook = asHookRecord(envelope.hookData);
    const merged = envelope.turnId !== undefined
        ? { ...hook, turn_id: envelope.turnId }
        : getString(hook, 'hook_event_name') === 'MessageDisplay'
            ? { ...hook, turn_id: undefined }
            : hook;
    return normalizer.normalizeHook(merged);
}
export function createClaudeCodeHookEventNormalizer(options) {
    const invocationId = options.invocationId;
    const sequencer = createInvocationEventSequencer({ now: options.now });
    const completedTurns = new Set();
    let activeTurnId;
    const messageDisplays = new Map();
    let heldAssistantMessage;
    // Fallback allocator when the shared one is not wired (one-shot envelope path
    // always carries a turn id, so it never actually mints). Mirrors the driver's
    // `turn_${invocationId}_${n}` namespace so any minted id stays consistent.
    let fallbackCounter = 0;
    const allocateTurnId = options.allocateTurnId ??
        (() => {
            fallbackCounter += 1;
            return `turn_${options.invocationId}_${fallbackCounter}`;
        });
    const emit = (rawType, event) => {
        return sequencer.next(invocationId, event.type, event.payload, {
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
            ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
            driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType },
        });
    };
    const flushHeldAssistantMessage = (final, fallbackTurnId) => {
        if (heldAssistantMessage === undefined)
            return [];
        const message = heldAssistantMessage;
        heldAssistantMessage = undefined;
        return [
            emit('MessageDisplay', {
                type: 'assistant.message.completed',
                payload: {
                    messageId: message.messageId,
                    content: [{ type: 'text', text: message.content }],
                    final,
                },
                turnId: message.turnId ?? fallbackTurnId,
                itemId: message.messageId,
            }),
        ];
    };
    const normalizeMessageDisplay = (unwrapped, turnId) => {
        const messageId = getString(unwrapped, 'message_id');
        const delta = getString(unwrapped, 'delta');
        const index = getNumber(unwrapped, 'index');
        if (turnId === undefined)
            return [];
        if (messageId === undefined || delta === undefined || index === undefined)
            return [];
        const events = [];
        if (heldAssistantMessage !== undefined && heldAssistantMessage.messageId !== messageId) {
            events.push(...flushHeldAssistantMessage(false, turnId));
        }
        const display = messageDisplays.get(messageId) ?? {
            messageId,
            turnId,
            chunks: new Map(),
        };
        if (display.turnId === undefined) {
            display.turnId = turnId;
        }
        display.chunks.set(index, delta);
        messageDisplays.set(messageId, display);
        if (unwrapped['final'] === true) {
            const content = [...display.chunks.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, text]) => text)
                .join('');
            messageDisplays.delete(messageId);
            if (content.length > 0) {
                heldAssistantMessage = {
                    messageId,
                    turnId: display.turnId,
                    content,
                };
            }
        }
        return events;
    };
    return {
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the stateful dispatch table for Claude's hook vocabulary.
        normalizeHook(hook) {
            const unwrapped = unwrapHookPayload(hook);
            const rawType = getString(unwrapped, 'hook_event_name') ?? 'unknown';
            const rawTurnId = getString(unwrapped, 'turn_id');
            const sessionId = getString(unwrapped, 'session_id');
            const turnIdText = rawTurnId ?? activeTurnId;
            const turnId = turnIdText !== undefined ? asTurnId(turnIdText) : undefined;
            if (rawType === 'SessionStart') {
                if (sessionId === undefined)
                    return [];
                return [
                    emit(rawType, {
                        type: 'continuation.updated',
                        payload: { provider: 'anthropic', kind: 'session', key: sessionId },
                    }),
                ];
            }
            if (rawType === 'UserPromptSubmit') {
                // Resolve the turn id for this prompt (C-02755 step 3): prefer an
                // explicit raw turn id; otherwise reuse the active turn ONLY while it is
                // still open; otherwise MINT a fresh id via the shared allocator. This
                // fixes cold-start (no active turn yet) AND post-completed operator
                // prompts (active turn already terminal) — both previously dropped.
                let resolvedText;
                if (rawTurnId !== undefined) {
                    resolvedText = rawTurnId;
                }
                else if (activeTurnId !== undefined && !completedTurns.has(activeTurnId)) {
                    resolvedText = activeTurnId;
                }
                else {
                    resolvedText = allocateTurnId();
                }
                activeTurnId = resolvedText;
                const events = [
                    emit(rawType, {
                        type: 'turn.started',
                        // Provenance-visible (T-04846 / #8236): a start observed from the
                        // Claude UserPromptSubmit hook, distinct from a broker-delivery
                        // synthesized start. The broker dedupes by turnId, so whichever
                        // seam lands first wins and its `source` reflects the live path.
                        payload: { turnId: resolvedText, source: 'hook-observed' },
                        turnId: asTurnId(resolvedText),
                    }),
                ];
                // Carry the prompt the operator typed directly into the TUI (T-02026):
                // the hook payload's `prompt` is the only place it appears, and without
                // a dedicated channel it was dropped for interactive turns. Emit it as a
                // `user.message` so HRC can record `turn.user_prompt` and the viewer can
                // render the typed text. Skip empty prompts (no text to surface).
                const promptText = getString(unwrapped, 'prompt');
                if (promptText !== undefined && promptText.length > 0) {
                    events.push(emit(rawType, {
                        type: 'user.message',
                        payload: { content: promptText, turnId: asTurnId(resolvedText) },
                        turnId: asTurnId(resolvedText),
                    }));
                }
                return events;
            }
            if (rawType === 'PreToolUse') {
                const events = flushHeldAssistantMessage(false, turnId);
                const toolCallId = getString(unwrapped, 'tool_use_id');
                if (turnId === undefined || toolCallId === undefined)
                    return events;
                events.push(emit(rawType, {
                    type: 'tool.call.started',
                    payload: {
                        toolCallId,
                        name: getString(unwrapped, 'tool_name') ?? 'tool',
                        ...(unwrapped['tool_input'] !== undefined ? { input: unwrapped['tool_input'] } : {}),
                    },
                    turnId,
                    itemId: toolCallId,
                }));
                return events;
            }
            if (rawType === 'PostToolUse') {
                const events = flushHeldAssistantMessage(false, turnId);
                const toolCallId = getString(unwrapped, 'tool_use_id');
                if (turnId === undefined || toolCallId === undefined)
                    return events;
                const name = getString(unwrapped, 'tool_name') ?? 'tool';
                const isError = unwrapped['is_error'] === true;
                const { output, responseObject } = formatToolOutput({
                    toolName: name,
                    toolInput: unwrapped['tool_input'],
                    toolResponse: unwrapped['tool_response'],
                    isError,
                });
                events.push(emit(rawType, {
                    type: 'tool.call.completed',
                    payload: {
                        toolCallId,
                        name,
                        isError,
                        result: {
                            content: [{ type: 'text', text: output ?? '' }],
                            ...(responseObject !== undefined ? { details: responseObject } : {}),
                        },
                    },
                    turnId,
                    itemId: toolCallId,
                }));
                return events;
            }
            if (rawType === 'MessageDisplay') {
                return normalizeMessageDisplay(unwrapped, turnId);
            }
            if (rawType === 'Notification') {
                const message = getString(unwrapped, 'message') ?? 'notification';
                const toolCallId = getString(unwrapped, 'tool_use_id');
                if (toolCallId !== undefined) {
                    return [
                        emit(rawType, {
                            type: 'tool.call.delta',
                            payload: {
                                toolCallId,
                                text: message,
                                data: { rawHook: unwrapped },
                            },
                            ...(turnId !== undefined ? { turnId } : {}),
                            itemId: toolCallId,
                        }),
                    ];
                }
                return [
                    emit(rawType, {
                        type: 'driver.notice',
                        payload: {
                            message,
                            data: { rawHook: unwrapped },
                        },
                        ...(turnId !== undefined ? { turnId } : {}),
                    }),
                ];
            }
            if (rawType === 'Stop' || rawType === 'SessionEnd' || rawType === 'SubagentStop') {
                // A user-initiated SessionEnd (Claude `/quit`, `/logout`, `/clear`)
                // means the operator deliberately ended the conversation: DROP the
                // captured continuation so the next launch starts fresh instead of
                // `--resume`-ing the quit session. External pane-kill / crash reports
                // reason `other` (or no SessionEnd), which we ignore so resume
                // durability survives pane recreation (T-01761 ariadne case).
                const prefix = [];
                if (rawType === 'SessionEnd') {
                    const endReason = getString(unwrapped, 'reason');
                    if (endReason !== undefined && USER_INITIATED_END_REASONS.has(endReason)) {
                        prefix.push(emit(rawType, {
                            type: 'continuation.cleared',
                            payload: { reason: endReason },
                        }));
                    }
                }
                // Terminal assistant message is sourced from Stop's authoritative
                // `last_assistant_message`, NOT from a held MessageDisplay (T-01722
                // Phase G flake fix). Claude fires the terminal MessageDisplay{final:true}
                // and Stop at end-of-turn as two SEPARATE racing hook-bridge processes;
                // the MessageDisplay was observed landing 2–44ms AFTER Stop ~40% of runs,
                // so `flushHeldAssistantMessage(true)` found nothing held and the row went
                // red on final_message_count=0 (the late MessageDisplay then orphaned).
                // Stop carries the same text in `last_assistant_message`, so emit the
                // terminal final:true straight from it — race-free. The held terminal
                // message (present only when the MessageDisplay won the race) is discarded
                // to avoid a double final. Fall back to the held flush only when Stop has
                // no last_assistant_message (SessionEnd/SubagentStop, older claude).
                const lastAssistantMessage = getString(unwrapped, 'last_assistant_message')?.trim();
                const turnAlreadyDone = turnIdText !== undefined && completedTurns.has(turnIdText);
                let events;
                if (lastAssistantMessage !== undefined &&
                    lastAssistantMessage.length > 0 &&
                    turnId !== undefined &&
                    !turnAlreadyDone) {
                    const messageId = heldAssistantMessage?.messageId ?? `${turnIdText}_final`;
                    heldAssistantMessage = undefined;
                    events = [
                        emit('MessageDisplay', {
                            type: 'assistant.message.completed',
                            payload: {
                                messageId,
                                content: [{ type: 'text', text: lastAssistantMessage }],
                                final: true,
                            },
                            turnId,
                            itemId: messageId,
                        }),
                    ];
                }
                else {
                    events = flushHeldAssistantMessage(true, turnId);
                }
                if (turnIdText === undefined || turnId === undefined || completedTurns.has(turnIdText)) {
                    return [...prefix, ...events];
                }
                // Emit exactly one terminal for this turn, mark it terminal for dedupe,
                // and clear the active turn when it matches so the NEXT turn-id-less
                // prompt mints a fresh id instead of reusing a completed one (C-02755
                // step 4).
                completedTurns.add(turnIdText);
                if (activeTurnId === turnIdText) {
                    activeTurnId = undefined;
                }
                events.push(emit(rawType, {
                    type: 'turn.completed',
                    payload: { turnId: turnIdText, status: 'completed' },
                    turnId,
                }));
                return [...prefix, ...events];
            }
            if (rawType === 'PreCompact') {
                const trigger = getString(unwrapped, 'trigger');
                const customInstructions = getString(unwrapped, 'custom_instructions');
                const triggerLabel = trigger ? ` (${trigger})` : '';
                return [
                    emit(rawType, {
                        type: 'diagnostic',
                        payload: {
                            level: 'info',
                            source: 'harness',
                            message: `Context compaction${triggerLabel}`,
                            data: {
                                ...(trigger !== undefined ? { trigger } : {}),
                                ...(customInstructions !== undefined ? { customInstructions } : {}),
                                ...(compactHookDetails(unwrapped) !== undefined
                                    ? { details: compactHookDetails(unwrapped) }
                                    : {}),
                            },
                        },
                        ...(turnId !== undefined ? { turnId } : {}),
                    }),
                ];
            }
            if (rawType === 'SubagentStart') {
                const agentId = getString(unwrapped, 'agent_id');
                const agentType = getString(unwrapped, 'agent_type');
                const label = agentType !== undefined || agentId !== undefined
                    ? `${agentType ?? 'subagent'}${agentId !== undefined ? ` (${agentId})` : ''}`
                    : 'subagent';
                return [
                    emit(rawType, {
                        type: 'driver.notice',
                        payload: {
                            message: `Subagent start: ${label}`,
                            code: 'subagent_start',
                            data: {
                                ...(agentId !== undefined ? { agentId } : {}),
                                ...(agentType !== undefined ? { agentType } : {}),
                                rawHook: unwrapped,
                            },
                        },
                        ...(turnId !== undefined ? { turnId } : {}),
                    }),
                ];
            }
            if (rawType === 'PermissionRequest') {
                const permissionRequestId = getString(unwrapped, 'permission_request_id');
                const kind = getString(unwrapped, 'kind');
                const defaultDecision = getString(unwrapped, 'default_decision');
                if (permissionRequestId === undefined ||
                    kind === undefined ||
                    unwrapped['subject_display'] === undefined ||
                    (defaultDecision !== 'allow' && defaultDecision !== 'deny')) {
                    return [];
                }
                return [
                    emit(rawType, {
                        type: 'permission.requested',
                        payload: {
                            permissionRequestId: permissionRequestId,
                            kind,
                            subjectDisplay: unwrapped['subject_display'],
                            defaultDecision,
                            ...(typeof unwrapped['deadline_ms'] === 'number'
                                ? { deadlineMs: unwrapped['deadline_ms'] }
                                : {}),
                        },
                        ...(turnId !== undefined ? { turnId } : {}),
                    }),
                ];
            }
            if (rawType === 'PermissionResolved') {
                const permissionRequestId = getString(unwrapped, 'permission_request_id');
                const decision = getString(unwrapped, 'decision');
                const decidedBy = getString(unwrapped, 'decided_by');
                if (permissionRequestId === undefined ||
                    (decision !== 'allow' && decision !== 'deny') ||
                    (decidedBy !== 'policy' &&
                        decidedBy !== 'user' &&
                        decidedBy !== 'api' &&
                        decidedBy !== 'timeout')) {
                    return [];
                }
                return [
                    emit(rawType, {
                        type: 'permission.resolved',
                        payload: {
                            permissionRequestId: permissionRequestId,
                            decision,
                            decidedBy,
                            ...(typeof unwrapped['message'] === 'string'
                                ? { message: unwrapped['message'] }
                                : {}),
                        },
                        ...(turnId !== undefined ? { turnId } : {}),
                    }),
                ];
            }
            return [];
        },
        normalizeToolCallFailure(failure) {
            return sequencer.next(invocationId, 'tool.call.failed', {
                toolCallId: failure.toolCallId,
                name: failure.name,
                message: failure.message,
                ...(failure.code !== undefined ? { code: failure.code } : {}),
                ...(failure.data !== undefined ? { data: failure.data } : {}),
            }, {
                turnId: asTurnId(failure.turnId),
                itemId: failure.toolCallId,
                driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'driver.failure' },
            });
        },
    };
}
function compactHookDetails(hook) {
    const details = {};
    for (const [key, value] of Object.entries(hook)) {
        if (key === 'hook_event_name' ||
            key === 'cp_run_id' ||
            key === 'session_id' ||
            key === 'transcript_path' ||
            key === 'permission_mode' ||
            key === 'cwd' ||
            key === 'trigger' ||
            key === 'custom_instructions') {
            continue;
        }
        details[key] = value;
    }
    return Object.keys(details).length > 0 ? details : undefined;
}
function formatToolOutput(options) {
    const { toolName, toolInput, toolResponse, isError } = options;
    const toolInputRecord = asRecordOrUndefined(toolInput);
    let toolOutput;
    let toolResponseObject;
    if (typeof toolResponse === 'string') {
        toolOutput = toolResponse;
    }
    else if (Array.isArray(toolResponse)) {
        toolResponseObject = { content: toolResponse };
        toolOutput = extractTextFromContent(toolResponse);
    }
    else if (toolResponse !== null && typeof toolResponse === 'object') {
        const response = toolResponse;
        toolResponseObject = response;
        const stdout = response['stdout'];
        const stderr = response['stderr'];
        if (typeof stdout === 'string') {
            toolOutput = stdout;
        }
        else if (typeof stderr === 'string') {
            toolOutput = stderr;
        }
        const content = response['content'];
        if (toolOutput === undefined && Array.isArray(content)) {
            toolOutput = extractTextFromContent(content);
        }
    }
    if (!isError && toolName === 'Write' && toolInputRecord !== undefined) {
        const filePath = getString(toolInputRecord, 'file_path');
        const content = getString(toolInputRecord, 'content');
        if (filePath !== undefined && content !== undefined) {
            const fileName = filePath.split('/').pop() || filePath;
            const lineCount = content.split('\n').length;
            toolOutput = `Created ${fileName} with ${lineCount} lines`;
        }
    }
    if (toolOutput === undefined && toolResponse !== undefined) {
        toolOutput = stringifyToolValue(toolResponse);
    }
    return {
        ...(toolOutput !== undefined ? { output: toolOutput } : {}),
        ...(toolResponseObject !== undefined ? { responseObject: toolResponseObject } : {}),
    };
}
function extractTextFromContent(content) {
    if (typeof content === 'string')
        return content;
    return content
        .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .filter(Boolean)
        .join('\n');
}
function stringifyToolValue(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
function asRecordOrUndefined(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    return value;
}
function asTurnId(value) {
    return value;
}
//# sourceMappingURL=hook-events.js.map