import { createInvocationEventSequencer } from '../../events';
import { asRecord as asHookRecord, getString, unwrapHookPayload } from '../hook-json';
import { USER_INITIATED_END_REASONS } from '../tmux-shared';
export const CODEX_CLI_TMUX_DRIVER_KIND = 'codex-cli-tmux';
/**
 * Resolve the base hook record carried by a codex-cli-tmux hook envelope: the
 * raw hook arrives under `hookData`, an alternate `hookEvent`, or `payload`,
 * falling back to the envelope itself. This is the one piece shared verbatim by
 * the driver's {@link extractCodexHookRecord} and {@link normalizeCodexHookEnvelope};
 * each then applies its OWN, intentionally divergent unwrap (the driver descends
 * a nested `hookEvent`; the normalizer merges the envelope turnId then defers to
 * `unwrapHookPayload`). Only this base resolution is consolidated — the divergent
 * tails are preserved.
 */
export function resolveCodexEnvelopeRecord(envelope) {
    return asHookRecord(envelope.hookData ?? envelope.hookEvent ?? envelope.payload ?? envelope);
}
/**
 * Driver-side hook extraction: resolve the base record, then descend into a
 * nested `hookEvent` wrapper when the resolved record carries one. NOTE: this
 * intentionally differs from the normalizer's `unwrapHookPayload` (which prefers
 * a top-level `hook_event_name` over a nested one) — do NOT merge the two.
 */
export function extractCodexHookRecord(envelope) {
    const hook = resolveCodexEnvelopeRecord(envelope);
    const nested = asHookRecord(hook['hookEvent']);
    return nested['hook_event_name'] !== undefined ? nested : hook;
}
export function normalizeCodexHookEnvelope(envelope, options = {}) {
    const invocationId = envelope.invocationId ?? 'inv_codex_cli_tmux';
    const normalizer = options.normalizer ??
        createCodexCliTmuxHookEventNormalizer({
            invocationId,
            now: options.now ?? (() => new Date()),
        });
    const hook = resolveCodexEnvelopeRecord(envelope);
    const merged = envelope.turnId !== undefined && getString(hook, 'turn_id') === undefined
        ? { ...hook, turn_id: envelope.turnId }
        : hook;
    return normalizer.normalizeHook(merged);
}
export function createCodexCliTmuxHookEventNormalizer(options) {
    const invocationId = options.invocationId;
    const sequencer = createInvocationEventSequencer({ now: options.now });
    const activeToolsByTurnAndCommand = new Map();
    let permissionCounter = 0;
    const emit = (rawType, event) => {
        const envelope = sequencer.next(invocationId, event.type, event.payload, {
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
            ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
            driver: { kind: CODEX_CLI_TMUX_DRIVER_KIND, rawType },
        });
        if (event.correlation !== undefined) {
            envelope.correlation = event.correlation;
        }
        return envelope;
    };
    return {
        normalizeHook(hook) {
            const unwrapped = unwrapHookPayload(hook);
            const rawType = getString(unwrapped, 'hook_event_name') ?? 'unknown';
            const turnIdText = getString(unwrapped, 'turn_id');
            const sessionId = getString(unwrapped, 'session_id');
            const turnId = turnIdText !== undefined ? turnIdText : undefined;
            if (rawType === 'UserPromptSubmit') {
                if (turnIdText === undefined || turnId === undefined)
                    return [];
                const promptText = getString(unwrapped, 'prompt');
                const events = [
                    emit(rawType, {
                        type: 'turn.started',
                        payload: {
                            turnId: turnIdText,
                            ...(sessionId !== undefined ? { sessionId } : {}),
                            ...(promptText !== undefined ? { prompt: promptText } : {}),
                        },
                        turnId,
                    }),
                ];
                // Carry the operator-typed prompt on a dedicated channel (T-02026) so
                // HRC records `turn.user_prompt` for interactive turns and the viewer
                // renders the typed text. Skip empty prompts.
                if (promptText !== undefined && promptText.length > 0) {
                    events.push(emit(rawType, {
                        type: 'user.message',
                        payload: { content: promptText, turnId },
                        turnId,
                    }));
                }
                return events;
            }
            if (rawType === 'PreToolUse') {
                const toolCallId = getString(unwrapped, 'tool_use_id');
                if (turnId === undefined || turnIdText === undefined || toolCallId === undefined)
                    return [];
                const name = getString(unwrapped, 'tool_name') ?? 'tool';
                const input = unwrapped['tool_input'];
                const command = commandFromToolInput(input);
                if (command !== undefined) {
                    activeToolsByTurnAndCommand.set(toolKey(turnIdText, command), {
                        toolCallId,
                        name,
                        input,
                    });
                }
                return [
                    emit(rawType, {
                        type: 'tool.call.started',
                        payload: {
                            toolCallId: toolCallId,
                            name,
                            ...(input !== undefined ? { input } : {}),
                        },
                        turnId,
                        itemId: toolCallId,
                    }),
                ];
            }
            if (rawType === 'PostToolUse') {
                const toolCallId = getString(unwrapped, 'tool_use_id');
                if (turnId === undefined || toolCallId === undefined)
                    return [];
                const name = getString(unwrapped, 'tool_name') ?? 'tool';
                const { output, details } = formatToolResult(unwrapped['tool_input'], unwrapped['tool_response']);
                return [
                    emit(rawType, {
                        type: 'tool.call.completed',
                        payload: {
                            toolCallId: toolCallId,
                            name,
                            isError: false,
                            result: {
                                output: output ?? '',
                                content: [{ type: 'text', text: output ?? '' }],
                                ...(details !== undefined ? { details } : {}),
                            },
                        },
                        turnId,
                        itemId: toolCallId,
                    }),
                ];
            }
            if (rawType === 'PermissionRequest') {
                if (turnId === undefined || turnIdText === undefined)
                    return [];
                const command = commandFromToolInput(unwrapped['tool_input']);
                const activeTool = command !== undefined
                    ? activeToolsByTurnAndCommand.get(toolKey(turnIdText, command))
                    : undefined;
                permissionCounter += 1;
                return [
                    emit(rawType, {
                        type: 'permission.requested',
                        payload: {
                            permissionRequestId: `perm_${options.invocationId}_${permissionCounter}`,
                            kind: command !== undefined ? 'command' : 'tool',
                            subjectDisplay: command !== undefined
                                ? { command }
                                : (unwrapped['tool_input'] ?? unwrapped['tool_name'] ?? {}),
                            defaultDecision: 'deny',
                        },
                        turnId,
                        ...(activeTool !== undefined
                            ? { correlation: { toolCallId: activeTool.toolCallId } }
                            : {}),
                    }),
                ];
            }
            if (rawType === 'Stop') {
                if (turnIdText === undefined || turnId === undefined)
                    return [];
                const finalOutput = getString(unwrapped, 'last_assistant_message') ?? '';
                const events = [
                    emit(rawType, {
                        type: 'turn.completed',
                        payload: {
                            turnId: turnIdText,
                            status: 'completed',
                            finalOutput,
                            producedContent: finalOutput.length > 0,
                        },
                        turnId,
                    }),
                ];
                if (sessionId !== undefined) {
                    events.push(emit(rawType, {
                        type: 'continuation.updated',
                        payload: { provider: 'openai', kind: 'session', key: sessionId },
                    }));
                }
                return events;
            }
            if (rawType === 'SessionEnd') {
                // Synthetic SessionEnd from the launch runner on harness exit. A
                // user-initiated end (`/quit` → clean exit → prompt_input_exit) drops the
                // continuation, which HRC's afterMappedEvent turns into the broker-tmux
                // lease reap that detaches the operator. A crash/external-kill reports
                // `other`, which we ignore so resume durability survives pane recreation.
                const endReason = getString(unwrapped, 'reason');
                if (endReason !== undefined && USER_INITIATED_END_REASONS.has(endReason)) {
                    return [
                        emit(rawType, {
                            type: 'continuation.cleared',
                            payload: { reason: endReason },
                        }),
                    ];
                }
                return [];
            }
            return [];
        },
    };
}
function formatToolResult(toolInput, toolResponse) {
    const command = commandFromToolInput(toolInput);
    if (typeof toolResponse === 'string') {
        return {
            output: toolResponse,
            details: {
                ...(command !== undefined ? { command } : {}),
                response: toolResponse,
            },
        };
    }
    if (toolResponse !== null && typeof toolResponse === 'object' && !Array.isArray(toolResponse)) {
        const response = toolResponse;
        const stdout = typeof response['stdout'] === 'string' ? response['stdout'] : undefined;
        const stderr = typeof response['stderr'] === 'string' ? response['stderr'] : undefined;
        return {
            output: stdout ?? stderr,
            details: {
                ...(command !== undefined ? { command } : {}),
                response,
            },
        };
    }
    return {
        details: command !== undefined ? { command, response: toolResponse ?? '' } : undefined,
    };
}
function commandFromToolInput(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const command = value['command'];
    return typeof command === 'string' ? command : undefined;
}
function toolKey(turnId, command) {
    return `${turnId}\0${command}`;
}
//# sourceMappingURL=hook-events.js.map