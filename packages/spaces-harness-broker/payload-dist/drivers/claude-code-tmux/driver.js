import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Ajv, {} from 'ajv';
import { BrokerErrorCode, CONSERVATIVE_LIFECYCLE_CAPABILITIES, } from 'spaces-harness-broker-protocol';
import { BrokerError } from '../../errors';
import { writeTmuxLaunchExecFiles } from '../../runtime/tmux-launch-exec';
import { asRecord as asHookRecord } from '../hook-json';
import { buildHookSocketPath, consumePaneLease, extractText, getInvocationRuntimeId, listenForHookEnvelopes, shellQuote, } from '../tmux-shared';
import { CLAUDE_CODE_TMUX_DRIVER_KIND, createClaudeCodeHookEventNormalizer, normalizeHookEnvelope, } from './hook-events';
import { createClaudeHookTranscriptReader, } from './hook-transcript';
const CLAUDE_CODE_TMUX_DRIVER_VERSION = '0.1.0';
/**
 * Live hook generation stamped into the launch env (HARNESS_BROKER_HOOK_GENERATION)
 * and used to fence out-of-band hook envelopes. A durable broker restart would
 * bump this; envelopes carrying a stale generation are rejected (T-01794 Phase D).
 */
const CLAUDE_HOOK_GENERATION = 1;
const CLAUDE_CODE_TMUX_CAPABILITIES = {
    input: {
        user: true,
        steer: false,
        appendContext: false,
        localImages: false,
        fileRefs: false,
        // Busy user input is accepted by the broker, then applied through
        // applySteerNow as an attempted steer. The TUI decides whether that text
        // affects the active turn, queues internally, or becomes a later prompt.
        queue: true,
    },
    turns: {
        concurrency: 'single',
        interrupt: 'process',
    },
    continuation: {
        supported: true,
        provider: 'anthropic',
        keyKind: 'session',
    },
    finalResponse: {
        jsonSchema: true,
        perTurn: true,
        strict: false,
        parsedResult: false,
    },
    events: {
        assistantDeltas: false,
        toolCalls: true,
        usage: false,
        diagnostics: true,
    },
    control: {
        stop: true,
        dispose: true,
        attach: true,
        // T-01794 Phase D: `attach` means an OPERATOR can `tmux attach` to the
        // live TUI. It does NOT imply the broker can restart this driver and
        // reattach it to an already-live surface — that distinct capability is
        // explicitly false (no driver attach-to-existing-surface impl in scope).
        driverAttachExistingSurface: false,
    },
    lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
};
const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 3;
// Broker-synthesized structured-output enforcement for claude-code-tmux uses
// Ajv draft-07 defaults with strict schema linting disabled, allErrors enabled,
// and schema validation enabled. This intentionally mirrors the advertised
// strict:false capability: Claude is prompted, then the driver validates the
// Stop-hook candidate before allowing final capture.
const structuredOutputAjv = new Ajv({
    strict: false,
    allErrors: true,
});
/**
 * Phase 3 broker driver: launches an OPERATOR-ATTACHABLE interactive Claude
 * Code in a tmux session (pty transport, terminal host = tmux), delivers turns
 * via send-keys, normalizes the out-of-band Claude hook stream into broker
 * events, and reports the runtime tmux attach surface.
 *
 * AD-008: NO live reattach / NO event replay / NO claim HRC can recover a broker
 * invocation after restart — operator attach is plain `tmux attach`.
 */
export function createClaudeCodeTmuxDriver(options) {
    const now = options.now ?? (() => new Date());
    let ctx;
    let surface;
    let hookListener;
    let transcriptReader;
    let hookDrain = Promise.resolve(undefined);
    // The runtime hands the driver a pane LEASE — `runtime.terminalSurface`
    // (kind: 'tmux-pane', ownership: 'hrc', T-01723 Phase A). The driver
    // attaches to that lease through a TmuxPaneController (T-01724 Phase B)
    // and NEVER constructs or owns a tmux session/server. All capability gates
    // (inspect, sendInput, sendInterrupt, capture, resize) come from the
    // lease's `allowedOps` set.
    let paneController;
    // Active broker turn id (cody's Phase 3 seam, H2). Set by applyInputNow so
    // raw hook envelopes that carry neither an envelope turn id nor a raw
    // `turn_id` still attribute turn.started/turn.completed to the live turn.
    let activeTurnId;
    let turnCounter = 0;
    const structuredTurns = new Map();
    const completedStructuredTurns = new Set();
    // Single shared per-invocation turn-id allocator (cody's blessed scheme,
    // C-02755). BOTH applyInputNow (manager path) and the hook normalizer (which
    // mints for turn-id-less operator prompts) call THIS closure so manager- and
    // normalizer-minted ids never collide and stay monotonic in turn-open order.
    function allocateTurnId() {
        turnCounter += 1;
        return `turn_${requireCtx().invocationId}_${turnCounter}`;
    }
    function requireCtx() {
        if (ctx === undefined) {
            throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started');
        }
        return ctx;
    }
    function requireSurface() {
        if (surface === undefined) {
            throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'tmux surface not established');
        }
        return surface;
    }
    function requirePaneController() {
        if (paneController === undefined) {
            throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'tmux surface not established');
        }
        return paneController;
    }
    return {
        kind: CLAUDE_CODE_TMUX_DRIVER_KIND,
        version: CLAUDE_CODE_TMUX_DRIVER_VERSION,
        capabilities() {
            return CLAUDE_CODE_TMUX_CAPABILITIES;
        },
        async start(spec, driverCtx) {
            // T-01725 Phase C: the driver consumes a pane LEASE supplied on the
            // dispatch envelope as `runtime.terminalSurface` (kind: 'tmux-pane',
            // ownership: 'hrc'). It reads ONLY this field — never the legacy
            // `runtime.tmux.socketPath` boundary shim — so capability scope is
            // explicit and the driver cannot fall through to a server it owns.
            // consumePaneLease validates the lease shape, constructs the pane
            // controller (allowedOps-gated, capability-safe verbs only — never a
            // lifecycle command), inspects the leased pane, and fails loudly if the
            // tmux server's reported ids do not match the lease.
            const leased = await consumePaneLease(driverCtx, {
                driverKind: 'claude-code-tmux',
                ...(options.tmux.tmuxBin !== undefined ? { tmuxBin: options.tmux.tmuxBin } : {}),
                ...(options.tmux.exec !== undefined ? { exec: options.tmux.exec } : {}),
            });
            ctx = driverCtx;
            paneController = leased.controller;
            surface = leased.surface;
            const lease = leased.surface;
            // Wire the hook ingestion callback socket → normalize via the ENVELOPE
            // turn id seam → re-emit as broker events through ctx.emit. The shared
            // stateful normalizer preserves activeTurnId / completed-turn dedup.
            const normalizer = createClaudeCodeHookEventNormalizer({
                invocationId: driverCtx.invocationId,
                now,
                allocateTurnId,
            });
            const expectedRuntimeId = getInvocationRuntimeId(spec);
            hookDrain = Promise.resolve(undefined);
            // Hook-driven session-transcript reader (T-02027): captures the mid-turn /
            // steered prompts that fire NO UserPromptSubmit. Reads newly appended
            // transcript bytes synchronously in hook order, attributes each
            // `queue-operation`/`enqueue` line to the live broker turn (activeTurnId).
            const reader = createClaudeHookTranscriptReader({
                invocationId: driverCtx.invocationId,
                now,
                getCurrentTurnId: () => activeTurnId,
            });
            transcriptReader = reader;
            const handleHookEnvelope = async (envelope) => {
                if (envelope.invocationId !== driverCtx.invocationId) {
                    return;
                }
                if (expectedRuntimeId !== undefined &&
                    envelope.runtimeId !== undefined &&
                    envelope.runtimeId !== expectedRuntimeId) {
                    return;
                }
                // T-01794 Phase D: durable identity fencing. Reject an envelope whose
                // generation does not match the live launch generation — but STRICTLY
                // only when the field is present, so legacy/stdio rows that omit it are
                // never rejected for an absent field.
                if (envelope.generation !== undefined && envelope.generation !== CLAUDE_HOOK_GENERATION) {
                    return;
                }
                if (hookListener !== undefined && envelope.callbackSocket !== hookListener.socketPath) {
                    return;
                }
                // H2: when neither the envelope nor the raw hook carries a turn id, fall
                // back to the driver-tracked active broker turn id so turn lifecycle
                // events still resolve to the live turn. The fallback is only injected
                // while a turn is OPEN — it is cleared on terminal below so a stale,
                // already-completed id is never merged into raw turn_id indistinguishably
                // (C-02755 step 5); that lets the normalizer mint a fresh id for the next
                // turn-id-less operator prompt.
                let effectiveEnvelope = envelope.turnId === undefined && activeTurnId !== undefined
                    ? { ...envelope, turnId: activeTurnId }
                    : envelope;
                const structuredDecision = handleStructuredOutputHook(effectiveEnvelope);
                if (structuredDecision.action === 'drop') {
                    return structuredDecision.decision;
                }
                effectiveEnvelope = structuredDecision.envelope;
                // T-02027: read the session transcript BEFORE normalizing the triggering
                // hook so a mid-turn/steered prompt's `user.message` lands in hook order
                // ahead of this hook's normalized events. SessionStart captures the
                // transcript path; every other hook reads newly appended bytes.
                for (const event of reader.handleHook(asHookRecord(effectiveEnvelope.hookData))) {
                    driverCtx.emit(event.type, event.payload, {
                        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
                        ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
                        ...(event.driver !== undefined ? { driver: event.driver } : {}),
                    });
                }
                for (const event of normalizeHookEnvelope(effectiveEnvelope, { normalizer })) {
                    driverCtx.emit(event.type, event.payload, {
                        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
                        ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
                        ...(event.driver !== undefined ? { driver: event.driver } : {}),
                    });
                    // Provenance sync (C-02755 step 5): mirror the normalizer's turn
                    // lifecycle into the driver-side fallback id. After turn.started, point
                    // the fallback at the live turn (so its tool-call/Stop hooks resolve);
                    // after a terminal, clear it so the next turn-id-less prompt mints.
                    if (event.type === 'turn.started' && event.turnId !== undefined) {
                        activeTurnId = event.turnId;
                    }
                    else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
                        if (activeTurnId === event.turnId) {
                            activeTurnId = undefined;
                        }
                    }
                }
            };
            hookListener = await options.hooks.listen((envelope) => {
                hookDrain = hookDrain.then(() => handleHookEnvelope(envelope), () => handleHookEnvelope(envelope));
                return hookDrain;
            }, {
                invocationId: driverCtx.invocationId,
                ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
            });
            // T-01725 Q3: report-back. Echo the lease ids exactly so consumers can
            // confirm the lease the driver is operating from matches what HRC
            // handed out.
            driverCtx.emit('terminal.surface.reported', {
                kind: 'tmux-pane',
                socketPath: lease.socketPath,
                sessionId: lease.sessionId,
                windowId: lease.windowId,
                paneId: lease.paneId,
                ...(lease.sessionName !== undefined ? { sessionName: lease.sessionName } : {}),
                ...(lease.windowName !== undefined ? { windowName: lease.windowName } : {}),
            }, { driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } });
            // Launch Claude inside the LEASED pane (stdio inherits the pty —
            // attachable). H1: the launch installs a broker-owned Claude hook
            // settings overlay so the REAL runtime posts UserPromptSubmit /
            // PreToolUse / PostToolUse / Stop… to the broker callback socket
            // OUT-OF-BAND (not via stdout). Env vars alone do not make Claude
            // invoke hooks.
            const launchCommand = await buildLaunchCommandLine(spec, driverCtx, {
                invocationId: driverCtx.invocationId,
                ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
                callbackSocket: hookListener.socketPath,
                bridgeCommand: options.hooks.bridgeCommand,
            });
            // Deliver the launch via the hardened paste-confirm-submit path (T-01747),
            // matching codex-cli-tmux: (re)paste until the command renders at the
            // leased pane's prompt, then confirm the line advanced past it. A blind
            // send-keys + fixed sleep + Enter can drop on a cold pane's not-yet-reading
            // shell PTY or swallow the Enter; sendPastedLine observes the pane and
            // degrades to a single blind paste+gap+Enter only when capture is denied.
            await paneController.sendPastedLine(launchCommand);
            return { ok: true };
        },
        async applyInputNow(input) {
            requireCtx();
            requireSurface();
            const text = extractText(input);
            // H2: open a broker-tracked turn so out-of-band hook envelopes that omit a
            // turn id are attributed to this turn. Uses the SAME shared allocator as
            // the normalizer (C-02755) and is returned to the caller as the
            // authoritative turn id for this input.
            const turnId = allocateTurnId();
            activeTurnId = turnId;
            const prompt = promptForStructuredOutput(input, text, turnId);
            // terminal-literal-input turn delivery: literal text, a short TUI-friendly
            // pause, then Enter so shell expansion / key interpretation never mangles
            // the prompt and Claude reliably submits it.
            await requirePaneController().sendKeys(prompt);
            return { turnId: turnId };
        },
        async applySteerNow(input) {
            requireCtx();
            requireSurface();
            await requirePaneController().sendKeys(extractText(input));
        },
        async interrupt(_req) {
            // Parity with codex-cli-tmux: a stopped driver clears `surface`, so an
            // interrupt after stop reports no_active_turn rather than firing a stray
            // C-c at a pane the driver no longer considers live.
            if (surface === undefined || paneController === undefined) {
                return { accepted: false, effect: 'no_active_turn' };
            }
            await paneController.interrupt();
            return { accepted: true, effect: 'turn_interrupted' };
        },
        async stop(_req) {
            // T-01725: the driver does NOT own the tmux session/server and so does
            // not kill anything during stop. Pane lifecycle (kill-session, server
            // teardown) belongs to HRC / the pre-HRC harness — the driver simply
            // releases its hook listener. It also drops the surface so post-stop
            // interrupt/applyInputNow observe a not-live driver (codex parity); the
            // pane controller ref is retained until dispose, like codex-cli-tmux.
            await closeHookListener();
            // T-05092: final transcript drain BEFORE reset/turn-id loss, so a trailing
            // API-error row that no post-error hook would surface still reaches the
            // broker. The byte-offset tailer dedupes — already-read rows are not
            // replayed. Emitted through the live ctx so the broker sequences them.
            if (transcriptReader !== undefined && ctx !== undefined) {
                for (const event of transcriptReader.drain()) {
                    ctx.emit(event.type, event.payload, {
                        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
                        ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
                        ...(event.driver !== undefined ? { driver: event.driver } : {}),
                    });
                }
            }
            transcriptReader?.reset();
            transcriptReader = undefined;
            surface = undefined;
            return { accepted: true, state: 'exited' };
        },
        async dispose() {
            // T-01725: dispose releases driver-owned resources only — the hook
            // listener and the in-memory pane controller. tmux server / session
            // lifecycle stays with the runtime control plane.
            await closeHookListener();
            // T-05092: drain a trailing API-error row on a dispose-without-stop path.
            // After stop() the reader is already nulled, so a stop→dispose sequence
            // does not double-emit; the byte-offset tailer dedupes either way.
            if (transcriptReader !== undefined && ctx !== undefined) {
                for (const event of transcriptReader.drain()) {
                    ctx.emit(event.type, event.payload, {
                        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
                        ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
                        ...(event.driver !== undefined ? { driver: event.driver } : {}),
                    });
                }
            }
            transcriptReader?.reset();
            transcriptReader = undefined;
            ctx = undefined;
            surface = undefined;
            paneController = undefined;
            activeTurnId = undefined;
            structuredTurns.clear();
            completedStructuredTurns.clear();
        },
    };
    function promptForStructuredOutput(input, text, turnId) {
        if (input.responseFormat?.kind !== 'json_schema') {
            return text;
        }
        const schema = input.responseFormat.schema;
        const validator = structuredOutputAjv.compile(schema);
        structuredTurns.set(turnId, {
            turnId,
            schema,
            attempts: 0,
            validator,
        });
        completedStructuredTurns.delete(turnId);
        return `${text}\n\nreturn ONLY JSON matching this schema, no prose/markdown.\nSchema:\n${JSON.stringify(schema)}`;
    }
    function handleStructuredOutputHook(envelope) {
        const hook = asHookRecord(envelope.hookData);
        const rawType = typeof hook['hook_event_name'] === 'string' ? hook['hook_event_name'] : undefined;
        const turnId = envelope.turnId;
        if (turnId !== undefined &&
            completedStructuredTurns.has(turnId) &&
            rawType === 'MessageDisplay') {
            return { action: 'drop' };
        }
        if (turnId === undefined) {
            return { action: 'continue', envelope };
        }
        const state = structuredTurns.get(turnId);
        if (state === undefined) {
            return { action: 'continue', envelope };
        }
        if (rawType === 'MessageDisplay') {
            // T-05145 invariant: for claude-code-tmux a structured turn may NOT pass
            // final capture unless its turn-local validator positively cleared the
            // candidate. MessageDisplay is racy with Stop and is never authoritative
            // for structured final capture; Stop's last_assistant_message is the gate.
            return { action: 'drop' };
        }
        if (rawType !== 'Stop') {
            if (rawType === 'SessionEnd' || rawType === 'SubagentStop') {
                failStructuredTurn(state, 'Structured output ended before Stop validation cleared');
                return { action: 'drop' };
            }
            return { action: 'continue', envelope };
        }
        const candidate = typeof hook['last_assistant_message'] === 'string' ? hook['last_assistant_message'] : '';
        const validation = validateStructuredCandidate(state, candidate);
        if (validation.valid) {
            structuredTurns.delete(turnId);
            completedStructuredTurns.add(turnId);
            return {
                action: 'continue',
                envelope: {
                    ...envelope,
                    hookData: {
                        ...hook,
                        last_assistant_message: validation.normalized,
                    },
                },
            };
        }
        state.attempts += 1;
        const reason = formatValidationErrors(validation.errors);
        emitStructuredValidationNotice(state, reason, validation.errors);
        if (state.attempts < STRUCTURED_OUTPUT_MAX_ATTEMPTS) {
            return { action: 'drop', decision: { decision: 'block', reason } };
        }
        emitStructuredDiagnostic(state, candidate);
        failStructuredTurn(state, reason, validation.errors);
        return { action: 'drop' };
    }
    function validateStructuredCandidate(state, candidate) {
        const parsed = parseStructuredJsonCandidate(candidate);
        if (!parsed.valid) {
            return {
                valid: false,
                errors: [
                    {
                        instancePath: '',
                        schemaPath: '',
                        keyword: 'parse',
                        params: {},
                        message: parsed.message,
                    },
                ],
            };
        }
        if (state.validator(parsed.value)) {
            return { valid: true, normalized: JSON.stringify(parsed.value) };
        }
        return { valid: false, errors: [...(state.validator.errors ?? [])], parsed: parsed.value };
    }
    function parseStructuredJsonCandidate(candidate) {
        const trimmed = candidate.trim();
        const bare = tryParseJson(trimmed);
        if (bare.valid) {
            return bare;
        }
        const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
        if (fenced?.[1] !== undefined) {
            const fencedJson = tryParseJson(fenced[1].trim());
            if (fencedJson.valid) {
                return fencedJson;
            }
            return { valid: false, message: 'must be valid JSON matching schema' };
        }
        const prefixed = tryParsePrefixedJsonRoot(trimmed);
        if (prefixed.valid) {
            return prefixed;
        }
        return { valid: false, message: 'must be valid JSON matching schema' };
    }
    function tryParseJson(raw) {
        try {
            return { valid: true, value: JSON.parse(raw) };
        }
        catch {
            return { valid: false };
        }
    }
    function tryParsePrefixedJsonRoot(raw) {
        for (let index = 0; index < raw.length; index += 1) {
            const char = raw[index];
            if (char !== '{' && char !== '[') {
                continue;
            }
            const endIndex = findJsonRootEnd(raw, index);
            if (endIndex === undefined) {
                continue;
            }
            const json = raw.slice(index, endIndex);
            const parsed = tryParseJson(json);
            if (!parsed.valid) {
                continue;
            }
            if (raw.slice(endIndex).trim().length > 0) {
                return { valid: false };
            }
            return parsed;
        }
        return { valid: false };
    }
    function findJsonRootEnd(raw, startIndex) {
        const stack = [];
        let inString = false;
        let escaped = false;
        for (let index = startIndex; index < raw.length; index += 1) {
            const char = raw[index];
            if (char === undefined) {
                return undefined;
            }
            if (inString) {
                if (escaped) {
                    escaped = false;
                }
                else if (char === '\\') {
                    escaped = true;
                }
                else if (char === '"') {
                    inString = false;
                }
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === '{') {
                stack.push('}');
                continue;
            }
            if (char === '[') {
                stack.push(']');
                continue;
            }
            if (char === '}' || char === ']') {
                if (stack.pop() !== char) {
                    return undefined;
                }
                if (stack.length === 0) {
                    return index + 1;
                }
            }
        }
        return undefined;
    }
    function formatValidationErrors(errors) {
        if (errors.length === 0) {
            return 'must match schema';
        }
        return errors
            .slice(0, 3)
            .map((error) => {
            const path = error.instancePath.length > 0 ? error.instancePath : '/';
            return `${path} ${error.message ?? error.keyword}`.trim();
        })
            .join('; ');
    }
    function emitStructuredValidationNotice(state, reason, errors) {
        ctx?.emit('driver.notice', {
            message: reason,
            code: 'structured_output_validation_retry',
            data: { validation: formatValidationData(errors), attempts: state.attempts },
        }, {
            turnId: state.turnId,
            driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND },
        });
    }
    function emitStructuredDiagnostic(state, candidate) {
        ctx?.emit('diagnostic', {
            level: 'warn',
            source: 'harness',
            message: 'Structured output validation failed after retry cap',
            data: {
                code: 'StructuredOutputValidationFailed',
                rawCandidate: candidate,
            },
        }, {
            turnId: state.turnId,
            driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND },
        });
    }
    function failStructuredTurn(state, reason, errors = []) {
        structuredTurns.delete(state.turnId);
        completedStructuredTurns.add(state.turnId);
        ctx?.emit('turn.failed', {
            turnId: state.turnId,
            status: 'failed',
            message: reason,
            code: 'StructuredOutputValidationFailed',
            retryable: false,
            data: {
                validation: formatValidationData(errors),
                attempts: state.attempts,
            },
        }, {
            turnId: state.turnId,
            driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND },
        });
        if (activeTurnId === state.turnId) {
            activeTurnId = undefined;
        }
    }
    function formatValidationData(errors) {
        return errors.map((error) => ({
            path: error.instancePath.length > 0 ? error.instancePath : '/',
            keyword: error.keyword,
            message: error.message ?? error.keyword,
            params: error.params,
        }));
    }
    async function closeHookListener() {
        await hookDrain.catch(() => undefined);
        if (hookListener !== undefined) {
            const handle = hookListener;
            hookListener = undefined;
            await handle.close();
        }
    }
}
/** Claude Code hook events the broker overlay subscribes to. */
const HOOK_EVENT_NAMES = [
    'SessionStart',
    'UserPromptSubmit',
    'MessageDisplay',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'Notification',
    'SubagentStop',
    'SessionEnd',
];
const DEFAULT_HOOK_BRIDGE_COMMAND = 'harness-broker claude-hook';
/**
 * Build the Claude Code `--settings` overlay (H1). Env vars alone do NOT make
 * Claude invoke hooks; the runtime needs an actual `hooks` settings block whose
 * commands POST each hook payload to the broker callback socket. The bridge
 * command reads the hook JSON on stdin and the `HARNESS_BROKER_*` env to build
 * the envelope, then writes it to the callback socket (broker-owned, H3).
 */
export function buildClaudeHookSettingsOverlay(options) {
    const bridge = options.bridgeCommand ?? DEFAULT_HOOK_BRIDGE_COMMAND;
    const command = `${bridge} --socket ${shellQuote(options.callbackSocket)}`;
    const legacyCommandMarker = `${bridge} --socket ${options.callbackSocket}`;
    const decisionCommand = `${toDecisionBridgeCommand(bridge)} --socket ${shellQuote(options.callbackSocket)} --legacy-command ${shellQuote(legacyCommandMarker)}`;
    const matchAll = ['PreToolUse', 'PostToolUse'];
    const hooks = {};
    for (const event of HOOK_EVENT_NAMES) {
        const entry = {
            hooks: [{ type: 'command', command: event === 'Stop' ? decisionCommand : command }],
        };
        if (matchAll.includes(event)) {
            entry['matcher'] = '*';
        }
        hooks[event] = [entry];
    }
    return { hooks };
}
function toDecisionBridgeCommand(bridgeCommand) {
    return bridgeCommand.replace(/\bclaude-hook\b/, 'claude-hook-decision');
}
async function buildLaunchCommandLine(spec, ctx, hookEnv) {
    const env = {
        ...spec.process.lockedEnv,
        ...(ctx.dispatchEnv ?? {}),
        HARNESS_BROKER_INVOCATION_ID: hookEnv.invocationId,
        HARNESS_BROKER_CALLBACK_SOCKET: hookEnv.callbackSocket,
        HARNESS_BROKER_HOOK_EVENTS: HOOK_EVENT_NAMES.join(','),
        HARNESS_BROKER_HOOK_GENERATION: String(CLAUDE_HOOK_GENERATION),
        ...(hookEnv.runtimeId !== undefined ? { HARNESS_BROKER_RUNTIME_ID: hookEnv.runtimeId } : {}),
    };
    const launchArgs = await buildArgsWithMergedSettings(spec.process.args, hookEnv);
    const launch = await writeTmuxLaunchExecFiles(`${hookEnv.callbackSocket}.claude`, {
        argv: [spec.process.command, ...launchArgs],
        cwd: spec.process.cwd,
        env,
        ...(spec.launch !== undefined ? { prompts: spec.launch } : {}),
    });
    return launch.commandLine;
}
async function buildArgsWithMergedSettings(args, hookEnv) {
    const separatorIndex = args.indexOf('--');
    const preSeparatorArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
    const postSeparatorArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex);
    const durableSettingsPaths = [];
    const cleanedPreSeparatorArgs = [];
    for (let i = 0; i < preSeparatorArgs.length; i += 1) {
        const arg = preSeparatorArgs[i];
        if (arg === undefined)
            continue;
        if (arg === '--settings') {
            const settingsPath = preSeparatorArgs[i + 1];
            if (settingsPath !== undefined) {
                durableSettingsPaths.push(settingsPath);
                i += 1;
            }
            continue;
        }
        cleanedPreSeparatorArgs.push(arg);
    }
    const mergedSettingsPath = await writeMergedSettingsFile(durableSettingsPaths, hookEnv);
    return [...cleanedPreSeparatorArgs, '--settings', mergedSettingsPath, ...postSeparatorArgs];
}
async function writeMergedSettingsFile(durableSettingsPaths, hookEnv) {
    const { mkdir, readFile, writeFile } = await import('node:fs/promises');
    const mergedSettings = {};
    for (const settingsPath of durableSettingsPaths) {
        const raw = await readFile(settingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        Object.assign(mergedSettings, parsed);
    }
    Object.assign(mergedSettings, buildClaudeHookSettingsOverlay({
        callbackSocket: hookEnv.callbackSocket,
        bridgeCommand: hookEnv.bridgeCommand,
    }));
    const settingsPath = `${hookEnv.callbackSocket}.settings.json`;
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(mergedSettings, null, 2), 'utf8');
    return settingsPath;
}
/**
 * Default-configured driver for registry registration. Uses the real tmux
 * binary and a real Unix-domain hook callback socket. The socket is bound
 * lazily inside `start()` (construction is side-effect-free), so registering
 * this driver performs no I/O. T-01725: no default tmux socket — the live
 * pane lease (`runtime.terminalSurface`) supplies it on start.
 */
export function createDefaultClaudeCodeTmuxDriver(socketDir = join(tmpdir(), 'harness-broker')) {
    return createClaudeCodeTmuxDriver({
        tmux: {},
        hooks: {
            listen: (handler, context) => listenForHookEnvelopes(buildClaudeHookSocketPath(socketDir, context), handler),
        },
    });
}
export function buildClaudeHookSocketPath(socketDir, context) {
    return buildHookSocketPath(socketDir, 'claude-hooks', context);
}
//# sourceMappingURL=driver.js.map