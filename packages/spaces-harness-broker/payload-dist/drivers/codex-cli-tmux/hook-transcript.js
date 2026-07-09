import { createInvocationEventSequencer } from '../../events';
import { getNumber, getString } from '../hook-json';
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer';
import { CODEX_CLI_TMUX_DRIVER_KIND } from './hook-events';
export function createCodexHookTranscriptReader(options) {
    const invocationId = options.invocationId;
    const sequencer = createInvocationEventSequencer({ now: options.now });
    const tailer = createJsonlByteOffsetTailer();
    let held;
    let pendingDelta;
    let transcriptLastAgentMessage;
    let messageCounter = 0;
    const seenMessageIds = new Set();
    // Reset the per-line state machine. Offset/partial rewinding is owned by the
    // shared tailer (via retarget/clear).
    const resetState = () => {
        held = undefined;
        pendingDelta = undefined;
        transcriptLastAgentMessage = undefined;
        seenMessageIds.clear();
    };
    const completedEvent = (message, final) => {
        const turnId = options.getCurrentTurnId();
        return sequencer.next(invocationId, 'assistant.message.completed', {
            messageId: message.messageId,
            content: [{ type: 'text', text: message.content }],
            final,
        }, {
            ...(turnId !== undefined ? { turnId: turnId } : {}),
            itemId: message.messageId,
            driver: { kind: CODEX_CLI_TMUX_DRIVER_KIND, rawType: 'agent_message' },
        });
    };
    // A newly completed interim message: the previously held message (if any)
    // becomes final:false, then the new one is held as the latest candidate
    // terminal. Empty messages are never held or emitted.
    const holdMessage = (messageId, content, into) => {
        if (content.length === 0)
            return;
        if (held !== undefined) {
            into.push(completedEvent(held, false));
        }
        held = { messageId, content };
    };
    const flushHeldInterim = (into) => {
        if (held === undefined)
            return;
        const message = held;
        held = undefined;
        into.push(completedEvent(message, false));
    };
    // Flush the held message as the terminal answer. Uses the held content
    // verbatim (never concatenates interim prose); falls back to the rollout /
    // Stop terminal text only when the held message is missing or empty.
    const flushTerminal = (fallback, into) => {
        if (held !== undefined) {
            const content = held.content.length > 0 ? held.content : (fallback ?? '');
            const message = { messageId: held.messageId, content };
            held = undefined;
            if (content.length === 0)
                return false;
            into.push(completedEvent(message, true));
            return true;
        }
        if (fallback !== undefined && fallback.length > 0) {
            messageCounter += 1;
            into.push(completedEvent({
                messageId: `msg_${options.invocationId}_${messageCounter}`,
                content: fallback,
            }, true));
            return true;
        }
        return false;
    };
    const coalescePendingDelta = (into) => {
        if (pendingDelta === undefined)
            return;
        const { messageId, chunks } = pendingDelta;
        pendingDelta = undefined;
        if (seenMessageIds.has(messageId))
            return;
        const content = [...chunks.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, text]) => text)
            .join('');
        if (content.length === 0)
            return;
        seenMessageIds.add(messageId);
        holdMessage(messageId, content, into);
    };
    const messageIdFor = (entry, payload) => {
        const id = getString(payload, 'id') ??
            getString(payload, 'message_id') ??
            getString(payload, 'item_id') ??
            getString(entry, 'id') ??
            getString(entry, 'message_id') ??
            getString(entry, 'item_id');
        if (id !== undefined)
            return id;
        messageCounter += 1;
        return `msg_${options.invocationId}_${messageCounter}`;
    };
    const processLine = (line, into) => {
        if (line.trim().length === 0)
            return;
        let entry;
        try {
            const parsed = JSON.parse(line);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
                return;
            entry = parsed;
        }
        catch {
            return;
        }
        if (entry['type'] !== 'event_msg')
            return;
        const payloadValue = entry['payload'];
        if (payloadValue === null || typeof payloadValue !== 'object' || Array.isArray(payloadValue)) {
            return;
        }
        const payload = payloadValue;
        const payloadType = getString(payload, 'type');
        if (payloadType === 'agent_message_delta') {
            const delta = getString(payload, 'delta');
            if (delta === undefined)
                return;
            const idText = getString(payload, 'id') ??
                getString(payload, 'message_id') ??
                getString(payload, 'item_id');
            // A delta stream for a different message id completes the prior stream as
            // an interim message before this one begins.
            if (pendingDelta !== undefined && idText !== undefined && pendingDelta.messageId !== idText) {
                coalescePendingDelta(into);
            }
            if (pendingDelta === undefined) {
                pendingDelta = {
                    messageId: messageIdFor(entry, payload),
                    chunks: new Map(),
                };
            }
            const index = getNumber(payload, 'index') ?? pendingDelta.chunks.size;
            pendingDelta.chunks.set(index, delta);
            return;
        }
        if (payloadType === 'agent_message') {
            const message = getString(payload, 'message');
            if (message === undefined)
                return;
            const id = messageIdFor(entry, payload);
            // A consolidated agent_message supersedes its own streamed deltas; for a
            // different id, the streamed deltas complete as a prior interim first.
            if (pendingDelta !== undefined) {
                if (pendingDelta.messageId === id) {
                    pendingDelta = undefined;
                }
                else {
                    coalescePendingDelta(into);
                }
            }
            if (seenMessageIds.has(id))
                return;
            seenMessageIds.add(id);
            transcriptLastAgentMessage = message;
            if (getString(payload, 'phase') === 'commentary') {
                flushHeldInterim(into);
                into.push(completedEvent({ messageId: id, content: message }, false));
                return;
            }
            holdMessage(id, message, into);
            return;
        }
        if (payloadType === 'task_complete') {
            const lastAgent = getString(payload, 'last_agent_message');
            if (lastAgent !== undefined)
                transcriptLastAgentMessage = lastAgent;
        }
    };
    return {
        handleHook(hook) {
            const into = [];
            const rawType = getString(hook, 'hook_event_name');
            if (rawType === 'SessionStart') {
                const transcriptPath = getString(hook, 'transcript_path');
                if (transcriptPath !== undefined && transcriptPath.length > 0) {
                    if (tailer.retarget(transcriptPath))
                        resetState();
                }
                return into;
            }
            tailer.readNewLines((line) => processLine(line, into));
            if (rawType === 'PreToolUse' || rawType === 'PostToolUse') {
                // A pending assistant message at a tool boundary cannot be the terminal
                // answer for this turn. Flush it before the normalized tool event so
                // prose that Codex logged before a function_call appears before
                // tool.call.started when the transcript has reached the hook.
                coalescePendingDelta(into);
                flushHeldInterim(into);
            }
            if (rawType === 'Stop' || rawType === 'SubagentStop') {
                // Any in-flight delta stream completes; then the last agent message is
                // classified as the terminal answer. Stop.last_assistant_message (or the
                // rollout task_complete.last_agent_message) is only a fallback when the
                // transcript carried no usable terminal prose.
                coalescePendingDelta(into);
                const fallback = getString(hook, 'last_assistant_message') ?? transcriptLastAgentMessage;
                flushTerminal(fallback, into);
            }
            return into;
        },
        reset() {
            tailer.clear();
            messageCounter = 0;
            resetState();
        },
    };
}
//# sourceMappingURL=hook-transcript.js.map