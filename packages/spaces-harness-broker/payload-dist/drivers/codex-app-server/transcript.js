/**
 * T-04963 — operator transcript renderer for the Codex app-server pane.
 *
 * Mirrors the visual language of `hrcchat turn` (amber accent / teal done / red
 * error palette, a `┊` activity rail, `↳` tool output, a glyph-led turn header,
 * and a bold assistant answer) but is self-contained: the renderer process is
 * `exec bun`-launched from source into a tmux pane and cannot reach the
 * hrc-runtime render packages, so the styling is reimplemented here with raw
 * ANSI and no extra dependencies.
 *
 * Unlike `hrcchat turn` (one redrawn frame), this appends to a long-lived,
 * multi-turn scrollback pane, so it commits each event as it finalizes rather
 * than redrawing in place. The Codex broker emits a wider event vocabulary than
 * the HRC gateway (policy/surface/continuation/usage/lifecycle), so every event
 * type renders — ONLY the streaming `*.delta` events are folded away, since their
 * content is fully reconstructed by the matching `*.completed` event.
 */
const ANSI = {
    bold: '1',
    dim: '2',
    accent: '38;2;217;119;6', // amber — active / structural
    done: '38;2;13;148;136', // teal — success
    error: '38;2;185;28;28', // red — failure
    warn: '38;2;202;138;4', // gold — caution
    rule: '38;2;87;83;78', // grey — separators
};
/**
 * Build the ANSI palette. Each segment is wrapped-and-reset independently; we
 * never wrap an already-wrapped string, so a trailing reset can't truncate an
 * outer colour. Concatenate styled segments instead of nesting them.
 */
export function createTranscriptStyle(color) {
    const wrap = (code) => (value) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
    return {
        bold: wrap(ANSI.bold),
        dim: wrap(ANSI.dim),
        accent: wrap(ANSI.accent),
        done: wrap(ANSI.done),
        error: wrap(ANSI.error),
        warn: wrap(ANSI.warn),
        rule: wrap(ANSI.rule),
    };
}
const BODY = '  ';
const RAIL = '┊';
const DEFAULT_WIDTH = 96;
const MIN_WIDTH = 48;
const MAX_WIDTH = 120;
const MAX_TOOL_OUTPUT_LINES = 3;
const MAX_PREVIEW = 120;
const TOOL_GLYPH = {
    command: '$',
    file_change: '✎',
    mcp_tool: '⚡',
    web_search: '⌕',
    image_view: '◐',
};
function asRecord(value) {
    return value !== null && typeof value === 'object' ? value : {};
}
function str(value) {
    if (value === undefined || value === null)
        return '';
    if (typeof value === 'string')
        return value;
    return JSON.stringify(value);
}
function firstLine(value) {
    const idx = value.indexOf('\n');
    return idx === -1 ? value : value.slice(0, idx);
}
function clip(value, max = MAX_PREVIEW) {
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
function clampWidth(width) {
    if (width === undefined || !Number.isFinite(width))
        return DEFAULT_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(width)));
}
/** Greedy word-wrap to a content width, preserving explicit newlines. */
function wrap(text, width) {
    const out = [];
    for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
        if (rawLine.trim().length === 0) {
            out.push('');
            continue;
        }
        let line = '';
        for (const word of rawLine.split(/\s+/)) {
            if (line.length === 0) {
                line = word;
            }
            else if (line.length + 1 + word.length <= width) {
                line += ` ${word}`;
            }
            else {
                out.push(line);
                line = word;
            }
        }
        if (line.length > 0)
            out.push(line);
    }
    return out;
}
function formatTokens(value) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n))
        return str(value);
    return Math.round(n)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function formatElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0)
        return '';
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 10)
        return `${s.toFixed(1)}s`;
    if (s < 60)
        return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    return `${m}m${Math.round(s - m * 60)}s`;
}
function parseMs(time) {
    if (typeof time !== 'string')
        return Number.NaN;
    return Date.parse(time);
}
function toolGlyph(name) {
    return TOOL_GLYPH[name] ?? '⚙';
}
function toolPreview(input) {
    const rec = asRecord(input);
    if (typeof rec['command'] === 'string')
        return clip(rec['command']);
    for (const value of Object.values(rec)) {
        if (typeof value === 'string' && value.length > 0)
            return clip(value);
    }
    return clip(str(input));
}
function toolOutput(payload) {
    const result = asRecord(payload['result']);
    const raw = (typeof result['output'] === 'string' ? result['output'] : undefined) ?? str(payload['output']);
    return raw;
}
function truncateOutput(output) {
    const lines = output.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
    if (lines.length <= MAX_TOOL_OUTPUT_LINES)
        return lines;
    const remaining = lines.length - MAX_TOOL_OUTPUT_LINES;
    return [
        ...lines.slice(0, MAX_TOOL_OUTPUT_LINES),
        `… ${remaining} more line${remaining === 1 ? '' : 's'}`,
    ];
}
function shortId(id) {
    const cleaned = id.replace(/^(inv-|turn-|input-)/, '');
    return cleaned.length <= 12 ? cleaned : `${cleaned.slice(0, 8)}…`;
}
function extractAssistantText(payload) {
    if (typeof payload['text'] === 'string')
        return payload['text'];
    const content = payload['content'];
    if (!Array.isArray(content))
        return '';
    return content
        .map((block) => block !== null && typeof block === 'object'
        ? block['text']
        : undefined)
        .filter((t) => typeof t === 'string')
        .join('');
}
/**
 * Stateful transcript model. Coalesces assistant `*.delta` streams into the
 * finalized message, pairs `tool.call.started`/`completed` into a grouped block,
 * tracks per-turn usage + elapsed for the footer, and styles every other event
 * type with the shared palette.
 */
export function createCodexTranscriptModel(options) {
    const style = createTranscriptStyle(options.color ?? false);
    const width = clampWidth(options.width);
    const contentWidth = Math.max(MIN_WIDTH - BODY.length, width - BODY.length);
    const emit = options.emit;
    // Per-turn rolling state.
    const toolNames = new Map();
    let assistantBuffer = '';
    let assistantOpen = false;
    let turnStartMs = Number.NaN;
    let latestTokens;
    let headerShown = false;
    const railLine = (body) => `${BODY}${style.accent(RAIL)} ${body}`;
    const railCont = (body) => `${BODY}${style.accent(RAIL)}   ${body}`;
    const dimLine = (body) => `${BODY}${style.dim(`· ${body}`)}`;
    function flushAssistant(payload) {
        const text = extractAssistantText(payload) || assistantBuffer;
        assistantBuffer = '';
        assistantOpen = false;
        const trimmed = text.trim();
        if (trimmed.length === 0)
            return;
        emit('');
        for (const line of wrap(trimmed, contentWidth)) {
            emit(`${BODY}${style.bold(line)}`);
        }
    }
    function apply(event) {
        const p = asRecord(event.payload);
        switch (event.type) {
            // ── Startup / lifecycle (low-key, dim rail of '·' lines) ────────────
            case 'lifecycle.policy.accepted':
                emit(dimLine(`policy ${str(p['policyId'])} (${str(p['retentionMode']) || 'n/a'})`));
                return;
            case 'terminal.surface.reported':
                emit(dimLine(`surface ${str(p['kind'])} ${str(p['paneId'])}`));
                return;
            case 'invocation.started':
                emit(dimLine(`process pid=${str(p['pid'])}`));
                return;
            case 'continuation.updated':
                emit(dimLine(`thread ${shortId(str(p['key']))}`));
                return;
            case 'continuation.cleared':
                emit(dimLine(`thread cleared (${str(p['reason']) || 'n/a'})`));
                return;
            case 'input.accepted':
                emit(dimLine(`input ${str(p['disposition']) || 'accepted'}`));
                return;
            case 'invocation.ready': {
                if (!headerShown) {
                    headerShown = true;
                    emit('');
                    emit(`${BODY}${style.dim(`codex-app-server · ${shortId(options.invocationId)}`)}`);
                }
                emit(`${BODY}${style.done('●')} ${style.bold('ready')}`);
                return;
            }
            case 'invocation.exited':
                emit(dimLine(`exited code=${str(p['exitCode'])} signal=${str(p['signal'])}`));
                return;
            case 'invocation.failed':
                emit(`${BODY}${style.error(`✗ ${str(p['message'])}`)}`);
                return;
            case 'invocation.summary':
                emit(dimLine(`summary ${str(p['summary'] ?? p)}`));
                return;
            case 'driver.notice':
                emit(`${BODY}${style.warn(`⚠ ${str(p['message'])}`)}`);
                return;
            // ── Turn + message flow ─────────────────────────────────────────────
            case 'user.message': {
                const preview = clip(firstLine(str(p['content'])), 96);
                if (preview.length > 0)
                    emit(`${BODY}${style.dim(`▷ ${preview}`)}`);
                return;
            }
            case 'turn.started':
                turnStartMs = parseMs(event.time);
                latestTokens = undefined;
                emit('');
                emit(`${BODY}${style.accent('▶')} ${style.bold('turn')} ${style.dim(shortId(str(p['turnId'])))}`);
                return;
            case 'assistant.message.started':
                assistantBuffer = '';
                assistantOpen = true;
                return;
            case 'assistant.message.delta':
                if (assistantOpen)
                    assistantBuffer += str(p['text']);
                return; // streaming chunk — folded into the completed message
            case 'assistant.message.completed':
                flushAssistant(p);
                return;
            // ── Tool calls (grouped: started line + ↳ output) ───────────────────
            case 'tool.call.started': {
                const name = str(p['name']) || 'tool';
                toolNames.set(str(p['toolCallId'] ?? p['callId']), name);
                emit(railLine(`${toolGlyph(name)} ${style.bold(name)}  ${style.dim(toolPreview(p['input']))}`));
                return;
            }
            case 'tool.call.delta':
                return; // streaming chunk — folded into the completed output
            case 'tool.call.completed': {
                const output = toolOutput(p);
                const lines = output.trim().length > 0 ? truncateOutput(output) : [];
                lines.forEach((line, idx) => {
                    emit(railCont(style.dim(idx === 0 ? `↳ ${line}` : `  ${line}`)));
                });
                return;
            }
            case 'tool.call.failed': {
                const name = str(p['name']) || toolNames.get(str(p['toolCallId'] ?? p['callId'])) || 'tool';
                emit(railLine(style.error(`✗ ${name}  ${clip(str(p['message']))}`)));
                return;
            }
            // ── Diagnostics + telemetry (every level renders) ───────────────────
            case 'diagnostic': {
                const level = str(p['level']) || 'info';
                const message = str(p['message']);
                if (level === 'error')
                    emit(`${BODY}${style.error(`✗ ${message}`)}`);
                else if (level === 'warn')
                    emit(`${BODY}${style.warn(`⚠ ${message}`)}`);
                else if (level === 'info')
                    emit(`${BODY}${style.dim(`ℹ ${message}`)}`);
                else
                    emit(dimLine(message));
                return;
            }
            case 'usage.updated': {
                const total = asRecord(asRecord(p['usage'])['total']);
                latestTokens = total['totalTokens'];
                emit(dimLine(`${formatTokens(latestTokens)} tok`));
                return;
            }
            case 'turn.completed': {
                const elapsed = formatElapsed(parseMs(event.time) - turnStartMs);
                const stats = [
                    latestTokens !== undefined ? `${formatTokens(latestTokens)} tok` : '',
                    elapsed,
                ]
                    .filter((s) => s.length > 0)
                    .join(' · ');
                emit(`${BODY}${style.done('✓ done')}${stats.length > 0 ? style.dim(` · ${stats}`) : ''}`);
                return;
            }
            case 'turn.failed':
                emit(`${BODY}${style.error('✗ failed')}${style.dim(` · ${clip(str(p['message'] ?? p['finalOutput'] ?? p['code']))}`)}`);
                return;
            case 'turn.interrupted':
                emit(`${BODY}${style.warn('◼ interrupted')}`);
                return;
            default:
                emit(dimLine(`${event.type} ${clip(str(event.payload))}`));
        }
    }
    function readFailure(text) {
        emit(`${BODY}${style.error(`✗ ${text}`)}`);
    }
    return { apply, readFailure };
}
//# sourceMappingURL=transcript.js.map