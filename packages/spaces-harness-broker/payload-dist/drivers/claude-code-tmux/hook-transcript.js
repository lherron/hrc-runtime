import { createInvocationEventSequencer } from '../../events';
import { getString, unwrapHookPayload } from '../hook-json';
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer';
import { CLAUDE_CODE_TMUX_DRIVER_KIND } from './hook-events';
export function createClaudeHookTranscriptReader(options) {
    const invocationId = options.invocationId;
    const sequencer = createInvocationEventSequencer({ now: options.now });
    const tailer = createJsonlByteOffsetTailer();
    /**
     * Extract the human-readable API-error text from an assistant row. CC nests it
     * under `message.content[]` (array of `{type:'text', text}`), but tolerate a
     * plain-string `content` and a top-level `text` as fallbacks so the diagnostic
     * message is never `[object Object]` or empty.
     */
    const extractAssistantText = (entry) => {
        const message = entry['message'];
        if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
            const content = message['content'];
            if (typeof content === 'string')
                return content.trim();
            if (Array.isArray(content)) {
                const text = content
                    .map((part) => part !== null && typeof part === 'object' && !Array.isArray(part)
                    ? getString(part, 'text')
                    : undefined)
                    .filter((part) => part !== undefined && part.length > 0)
                    .join('');
                if (text.length > 0)
                    return text.trim();
            }
        }
        return getString(entry, 'text')?.trim() ?? '';
    };
    const apiErrorDiagnosticEvent = (entry) => {
        const turnIdText = options.getCurrentTurnId();
        const turnId = turnIdText !== undefined ? turnIdText : undefined;
        const message = extractAssistantText(entry);
        const requestId = getString(entry, 'requestId');
        const error = getString(entry, 'error');
        const status = entry['status'];
        return sequencer.next(invocationId, 'diagnostic', {
            level: 'error',
            source: 'harness',
            message: message.length > 0 ? message : 'Claude Code API error',
            data: {
                code: 'api_error',
                rawType: 'assistant',
                isApiErrorMessage: true,
                ...(typeof status === 'number' ? { apiErrorStatus: status } : {}),
                ...(requestId !== undefined ? { requestId } : {}),
                ...(error !== undefined ? { error } : {}),
            },
        }, {
            ...(turnId !== undefined ? { turnId } : {}),
            driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'assistant' },
        });
    };
    const userMessageEvent = (content) => {
        const turnIdText = options.getCurrentTurnId();
        const turnId = turnIdText !== undefined ? turnIdText : undefined;
        return sequencer.next(invocationId, 'user.message', {
            content,
            ...(turnId !== undefined ? { turnId } : {}),
        }, {
            ...(turnId !== undefined ? { turnId } : {}),
            driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'queue-operation' },
        });
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
        const entryType = getString(entry, 'type');
        // API failure: CC records an assistant row flagged isApiErrorMessage with no
        // hook. Emit a non-terminal diagnostic; never a terminal/lifecycle event.
        if (entryType === 'assistant' && entry['isApiErrorMessage'] === true) {
            into.push(apiErrorDiagnosticEvent(entry));
            return;
        }
        // Mid-turn/steered prompt: the ONLY transcript record is a queue-operation
        // enqueue carrying the typed text. A queue/remove (dequeue) follows but
        // carries no new prompt — only enqueue surfaces a typed prompt.
        if (entryType !== 'queue-operation')
            return;
        if (getString(entry, 'operation') !== 'enqueue')
            return;
        const content = getString(entry, 'content');
        if (content === undefined || content.length === 0)
            return;
        into.push(userMessageEvent(content));
    };
    return {
        handleHook(hook) {
            const into = [];
            const unwrapped = unwrapHookPayload(hook);
            const rawType = getString(unwrapped, 'hook_event_name');
            if (rawType === 'SessionStart') {
                const transcriptPath = getString(unwrapped, 'transcript_path');
                if (transcriptPath !== undefined && transcriptPath.length > 0) {
                    tailer.retarget(transcriptPath);
                }
                return into;
            }
            tailer.readNewLines((line) => processLine(line, into));
            return into;
        },
        drain() {
            const into = [];
            tailer.readNewLines((line) => processLine(line, into));
            return into;
        },
        reset() {
            tailer.clear();
        },
    };
}
//# sourceMappingURL=hook-transcript.js.map