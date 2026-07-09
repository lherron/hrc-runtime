import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { BrokerErrorCode, PROVIDER_TRANSCRIPT_ARTIFACT_KIND, emitProviderTranscriptReported, } from 'spaces-harness-broker-protocol';
import { BrokerError } from '../../errors';
import { spawnHarnessProcess } from '../../runtime/process-runner';
import { terminateProcess } from '../../runtime/signals';
import { buildHookSocketPath, consumePaneLease, extractText, getInvocationRuntimeId, listenForHookEnvelopes, } from '../tmux-shared';
import { CODEX_CAPABILITIES } from './capabilities';
import { createCodexNotificationMapper, parseCodexError } from './event-map';
import { buildTurnStartParams } from './input';
import { createPermissionRequestIdAllocator, handlePermissionRequest, } from './permissions';
import { buildRendererLaunchCommand } from './renderer';
import { CodexRpcClient, CodexRpcError } from './rpc-client';
const bunRuntime = typeof Bun !== 'undefined' ? Bun : undefined;
if (bunRuntime !== undefined && bunRuntime.execPath === undefined) {
    Object.defineProperty(Bun, 'execPath', {
        value: process.execPath,
        configurable: true,
    });
}
export function createCodexAppServerDriver() {
    let ctx;
    let spec;
    let driverSpec;
    let proc;
    let rpc;
    let threadId;
    let currentInputId;
    let currentTurnId;
    let turnActive = false;
    let startedEmitted = false;
    let terminalEmitted = false;
    let stopping = false;
    let starting = false;
    let rejectStartup;
    let startupFailure;
    let turnTimeout;
    let rendererControlListener;
    let rendererQuitAccepted = false;
    // Provider-transcript provenance state (T-05374). The broker-owned sidecar
    // captures RAW upstream Codex JSON-RPC notifications (pre-normalization) into a
    // verifier-compatible JSONL file; `reportedTranscriptPaths` fences provenance
    // emission to at-most-once per concrete absolute path per invocation.
    let transcriptSidecar;
    const reportedTranscriptPaths = new Set();
    const mapCodexNotification = createCodexNotificationMapper();
    const permissionRequestIds = createPermissionRequestIdAllocator();
    /**
     * Capture one raw upstream notification into the broker-owned sidecar BEFORE
     * normalization. Lazily opens the sidecar (deterministic absolute path) on the
     * first notification so scenarios that never receive one create no artifact.
     * Uses a synchronous write + fsync so the row is durable/readable before any
     * provenance event references the file.
     */
    function captureTranscriptRow(notification) {
        if (transcriptSidecar === undefined) {
            transcriptSidecar = openTranscriptSidecar(requireCtx());
        }
        const sidecar = transcriptSidecar;
        const row = notification.params !== undefined
            ? { jsonrpc: '2.0', method: notification.method, params: notification.params }
            : { jsonrpc: '2.0', method: notification.method };
        writeSync(sidecar.fd, `${JSON.stringify(row)}\n`);
        fsyncSync(sidecar.fd);
    }
    /**
     * Emit `provider.transcript.reported` through the normal broker emit path once
     * the turn terminal has flushed. Fenced to one provenance event per concrete
     * absolute path so a multi-turn invocation does not re-report the same file.
     */
    function reportProviderTranscript() {
        const sidecar = transcriptSidecar;
        if (sidecar === undefined)
            return;
        if (reportedTranscriptPaths.has(sidecar.path))
            return;
        fsyncSync(sidecar.fd);
        reportedTranscriptPaths.add(sidecar.path);
        emitProviderTranscriptReported(requireCtx(), {
            kind: PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
            artifactPath: sidecar.path,
            provider: 'codex',
        }, {
            ...(currentTurnId !== undefined ? { turnId: currentTurnId } : {}),
            ...(currentInputId !== undefined ? { inputId: currentInputId } : {}),
            driver: { kind: 'codex-app-server', rawType: 'provider-transcript.sidecar' },
        });
    }
    function closeTranscriptSidecar() {
        const sidecar = transcriptSidecar;
        transcriptSidecar = undefined;
        if (sidecar !== undefined) {
            try {
                fsyncSync(sidecar.fd);
            }
            catch {
                // best-effort flush on teardown
            }
            try {
                closeSync(sidecar.fd);
            }
            catch {
                // fd may already be closed
            }
        }
    }
    function requireCtx() {
        if (!ctx) {
            throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started');
        }
        return ctx;
    }
    function emitDiagnostic(level, message, data) {
        requireCtx().emit('diagnostic', {
            level,
            message,
            source: 'harness',
            ...(data !== undefined ? { data } : {}),
        });
    }
    function emitTerminalFailure(message, code, data) {
        if (terminalEmitted)
            return;
        terminalEmitted = true;
        requireCtx().emit('invocation.failed', {
            message,
            ...(code !== undefined ? { code } : {}),
            ...(data !== undefined ? { data } : {}),
        });
    }
    function onNotification(notification) {
        // Capture the RAW upstream notification before any normalization or special
        // error handling so the sidecar preserves verifier-compatible provider rows.
        captureTranscriptRow(notification);
        if (notification.method === 'error') {
            const error = parseCodexError(notification.params);
            emitDiagnostic('error', error.message, error.code !== undefined ? { code: error.code } : error.data);
            if (turnActive && currentTurnId) {
                requireCtx().emit('turn.failed', {
                    turnId: currentTurnId,
                    status: 'failed',
                    finalOutput: error.message,
                }, { turnId: currentTurnId, inputId: currentInputId });
            }
            else {
                emitTerminalFailure(error.message, error.code);
            }
            if (starting) {
                rejectStartup?.(new BrokerError(BrokerErrorCode.HarnessError, error.message, {
                    code: error.code,
                    data: error.data,
                }));
            }
            return;
        }
        // After any invocation-terminal event, drop further native events so a late
        // turn/completed (or any other notification) can never follow a terminal.
        if (terminalEmitted)
            return;
        for (const mapped of mapCodexNotification(notification)) {
            const isTurnTerminal = mapped.type === 'turn.completed' ||
                mapped.type === 'turn.failed' ||
                mapped.type === 'turn.interrupted';
            // Suppress a turn terminal for a turn that already reached a terminal
            // state (e.g. a turn-timeout turn.failed followed by a late turn/completed).
            if (isTurnTerminal && !turnActive)
                continue;
            const extra = mapped.type === 'turn.started' || isTurnTerminal
                ? { ...mapped.extra, inputId: currentInputId }
                : mapped.extra;
            const event = requireCtx().emit(mapped.type, mapped.payload, extra);
            if (event.type === 'turn.started') {
                currentTurnId = event.turnId;
                turnActive = true;
            }
            if (event.type === 'turn.completed' ||
                event.type === 'turn.failed' ||
                event.type === 'turn.interrupted') {
                turnActive = false;
                // Clear turn timeout on any turn termination
                if (turnTimeout !== undefined) {
                    clearTimeout(turnTimeout);
                    turnTimeout = undefined;
                }
                // Turn terminal flushed: report the provider transcript provenance once
                // the raw rows (including this terminal notification) are durable.
                reportProviderTranscript();
            }
        }
    }
    function onExit(code, signal) {
        if (!startedEmitted || terminalEmitted) {
            if (starting) {
                rejectStartup?.(new BrokerError(BrokerErrorCode.HarnessError, 'Harness process exited during startup', {
                    exitCode: code,
                    signal,
                }));
            }
            return;
        }
        if (turnActive && currentTurnId) {
            requireCtx().emit(stopping ? 'turn.interrupted' : 'turn.failed', {
                turnId: currentTurnId,
                status: stopping ? 'interrupted' : 'failed',
                ...(!stopping ? { finalOutput: 'Harness process exited during active turn' } : {}),
            }, { turnId: currentTurnId, inputId: currentInputId });
            turnActive = false;
        }
        terminalEmitted = true;
        requireCtx().emit('invocation.exited', { exitCode: code, signal });
    }
    function closeRendererControlListener() {
        const listener = rendererControlListener;
        rendererControlListener = undefined;
        if (listener !== undefined) {
            void listener.close();
        }
    }
    function rendererEnvelopeMatchesFence(envelope, expectedRuntimeId) {
        if (envelope.invocationId !== requireCtx().invocationId)
            return false;
        if (expectedRuntimeId !== undefined && envelope.runtimeId !== expectedRuntimeId)
            return false;
        if (rendererControlListener === undefined ||
            envelope.callbackSocket !== rendererControlListener.socketPath) {
            return false;
        }
        return true;
    }
    async function handleRendererQuit() {
        if (rendererQuitAccepted || terminalEmitted)
            return;
        rendererQuitAccepted = true;
        stopping = true;
        if (turnTimeout !== undefined) {
            clearTimeout(turnTimeout);
            turnTimeout = undefined;
        }
        requireCtx().emit('continuation.cleared', { reason: 'prompt_input_exit' }, { driver: { kind: 'codex-app-server', rawType: 'app-server-renderer.quit' } });
        if (proc !== undefined) {
            await terminateProcess({
                proc,
                graceMs: spec?.process.limits?.stopGraceMs ?? 1000,
            });
        }
        setTimeout(closeRendererControlListener, 0);
    }
    function handleRendererExited(envelope) {
        if (rendererQuitAccepted || terminalEmitted)
            return;
        emitDiagnostic('error', 'Codex app-server renderer exited unexpectedly', {
            exitCode: envelope.exitCode ?? null,
            signal: envelope.signal ?? null,
        });
    }
    async function startThread() {
        if (!rpc || !spec || !driverSpec) {
            throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver is not initialized');
        }
        const resumeThreadId = driverSpec.resumeThreadId ??
            (spec.continuation?.provider === 'codex' ? spec.continuation.key : undefined);
        const startParams = buildThreadStartParams(spec, driverSpec);
        if (!resumeThreadId) {
            return extractThreadId(await rpc.sendRequest('thread/start', startParams));
        }
        try {
            return extractThreadId(await rpc.sendRequest('thread/resume', {
                ...startParams,
                threadId: resumeThreadId,
                history: null,
                path: null,
            }));
        }
        catch (error) {
            if (!isMissingThreadError(error)) {
                throw error;
            }
            if ((driverSpec.resumeFallback ?? 'start-fresh') === 'fail') {
                const message = error instanceof Error ? error.message : 'Thread not found';
                const code = error instanceof CodexRpcError ? extractErrorCode(error) : undefined;
                emitDiagnostic('error', message, code !== undefined ? { code } : undefined);
                emitTerminalFailure(message, code);
                throw new BrokerError(BrokerErrorCode.HarnessError, message, { code });
            }
            requireCtx().emit('driver.notice', {
                message: `Codex thread ${resumeThreadId} was not found; starting a fresh thread`,
                code: 'resume_fallback_start_fresh',
                data: { missingThreadId: resumeThreadId },
            });
            return extractThreadId(await rpc.sendRequest('thread/start', startParams));
        }
    }
    return {
        kind: 'codex-app-server',
        version: '0.1.0',
        capabilities() {
            return CODEX_CAPABILITIES;
        },
        async start(startSpec, driverCtx) {
            if (startSpec.driver.kind !== 'codex-app-server') {
                throw new BrokerError(BrokerErrorCode.DriverUnavailable, 'Invalid Codex driver spec');
            }
            ctx = driverCtx;
            spec = startSpec;
            driverSpec = startSpec.driver;
            const activeDriverSpec = driverSpec;
            const expectedRuntimeId = getInvocationRuntimeId(startSpec);
            terminalEmitted = false;
            startedEmitted = false;
            stopping = false;
            starting = true;
            rendererQuitAccepted = false;
            closeTranscriptSidecar();
            reportedTranscriptPaths.clear();
            if (driverCtx.runtime?.terminalSurface !== undefined ||
                driverCtx.runtime?.terminalSurfaceRequired === true) {
                const leased = await consumePaneLease(driverCtx, {
                    driverKind: 'codex-app-server',
                });
                driverCtx.emit('terminal.surface.reported', {
                    kind: 'tmux-pane',
                    socketPath: leased.surface.socketPath,
                    sessionId: leased.surface.sessionId,
                    windowId: leased.surface.windowId,
                    paneId: leased.surface.paneId,
                    ...(leased.surface.sessionName !== undefined
                        ? { sessionName: leased.surface.sessionName }
                        : {}),
                    ...(leased.surface.windowName !== undefined
                        ? { windowName: leased.surface.windowName }
                        : {}),
                }, { driver: { kind: 'codex-app-server', rawType: 'tmux.surface' } });
                const controlSocketPath = buildRendererControlSocketPath(driverCtx, leased.surface, expectedRuntimeId);
                rendererControlListener = await listenForHookEnvelopes(controlSocketPath, async (envelope) => {
                    if (!rendererEnvelopeMatchesFence(envelope, expectedRuntimeId))
                        return;
                    if (envelope.type === 'app-server-renderer.quit') {
                        if (envelope.reason !== 'prompt_input_exit')
                            return;
                        await handleRendererQuit();
                        return;
                    }
                    if (envelope.type === 'app-server-renderer.exited') {
                        handleRendererExited(envelope);
                    }
                });
                // Launch the DRIVER-OWNED renderer into the leased pane. The renderer is
                // a presentation/observation process: it reads the broker's DURABLE
                // event surface (invocation.eventsSince + live invocation.event), NOT a
                // driver-pushed feed, so it stays coherent with HRC attach/replay. The
                // app-server JSON-RPC child started below remains the harness transport;
                // this never routes through codex-cli-tmux.
                const observerSocketPath = resolveRendererObserverSocket(driverCtx, leased.surface);
                await leased.controller.sendPastedLine(buildRendererLaunchCommand({
                    invocationId: driverCtx.invocationId,
                    observerSocketPath,
                    controlSocketPath: rendererControlListener.socketPath,
                    ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
                }));
            }
            startupFailure = new Promise((_resolve, reject) => {
                rejectStartup = reject;
            });
            // Prevent unhandled rejection when startupFailure outlives the race
            startupFailure.catch(() => { });
            // Codex credentials live on disk (auth.json via CODEX_HOME, a lockedEnv
            // path) — the credentials channel is empty. Only the per-invocation
            // dispatchEnv rides alongside the lockedEnv from the spec.
            proc = await spawnHarnessProcess(startSpec.process, {
                credentials: {},
                ...(driverCtx.dispatchEnv !== undefined ? { dispatchEnv: driverCtx.dispatchEnv } : {}),
            });
            proc.on('exit', onExit);
            createInterface({ input: proc.stderr }).on('line', (line) => {
                if (line.trim().length > 0) {
                    emitDiagnostic('info', line);
                }
            });
            const rpcClient = new CodexRpcClient(proc, {
                onNotification,
                onRequest: async (request) => {
                    const permCtx = {
                        ctx: requireCtx(),
                        driver: activeDriverSpec,
                        currentTurnId,
                        currentInputId,
                        permissionRequestIds,
                    };
                    return handlePermissionRequest(request, permCtx);
                },
                onError: (error) => {
                    if (starting) {
                        rejectStartup?.(error);
                    }
                },
            });
            rpc = rpcClient;
            // Wire startup timeout — timer starts when the first RPC is written,
            // so process boot time doesn't count against the limit.
            const startupTimeoutMs = startSpec.process.limits?.startupTimeoutMs;
            let startupTimedOut = false;
            let startupTimer;
            function armStartupTimer() {
                if (startupTimer !== undefined)
                    clearTimeout(startupTimer);
                if (startupTimeoutMs === undefined || startupTimeoutMs <= 0)
                    return;
                startupTimer = setTimeout(() => {
                    if (!starting)
                        return;
                    startupTimedOut = true;
                    emitTerminalFailure('Startup timed out', 'Timeout');
                    rpc?.close(new Error('Startup timed out'));
                    if (proc && proc.exitCode === null)
                        proc.kill('SIGTERM');
                    rejectStartup?.(new BrokerError(BrokerErrorCode.Timeout, 'Startup timed out'));
                }, startupTimeoutMs);
            }
            try {
                armStartupTimer();
                const initializeResult = await withStartupRace(rpcClient.sendRequest('initialize', {
                    clientInfo: { name: 'harness-broker', version: '0.1.0' },
                }));
                validateInitializeHandshake(initializeResult, emitDiagnostic);
                armStartupTimer(); // re-arm after successful initialize
                await withStartupRace(rpcClient.sendNotification('initialized', {}));
                armStartupTimer(); // re-arm after initialized notification
                threadId = await withStartupRace(startThread());
            }
            catch (startupErr) {
                if (startupTimer !== undefined)
                    clearTimeout(startupTimer);
                if (startupTimedOut) {
                    throw new BrokerError(BrokerErrorCode.Timeout, 'Startup timed out');
                }
                throw startupErr;
            }
            if (startupTimer !== undefined)
                clearTimeout(startupTimer);
            requireCtx().emit('invocation.started', {
                pid: proc.pid,
                command: startSpec.process.command ?? process.execPath,
                args: startSpec.process.args,
                cwd: startSpec.process.cwd,
            });
            startedEmitted = true;
            requireCtx().emit('continuation.updated', {
                provider: 'codex',
                kind: 'thread',
                key: threadId,
            });
            requireCtx().emit('invocation.ready', {});
            starting = false;
            rejectStartup = undefined;
            startupFailure = undefined;
            return { ok: true };
        },
        // Driver applies the input immediately — broker manager owns all policy,
        // disposition, and queue semantics. No policy or busy checks here.
        async applyInputNow(input) {
            if (!rpc || !spec || !driverSpec || !threadId) {
                throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Invocation is not ready');
            }
            const inputId = input.inputId ?? `input_${Date.now().toString(36)}`;
            currentInputId = inputId;
            requireCtx().emit('user.message', {
                content: extractText(input),
                inputId,
                role: 'user',
            }, { inputId, driver: { kind: 'codex-app-server', rawType: 'broker.input' } });
            // Wire turn timeout
            const turnTimeoutMs = spec.process.limits?.turnTimeoutMs;
            let turnTimedOut = false;
            if (turnTimeoutMs !== undefined && turnTimeoutMs > 0) {
                turnTimeout = setTimeout(() => {
                    // Skip timeout if stopping/exited — the stop path handles turn teardown
                    if (stopping || terminalEmitted)
                        return;
                    turnTimedOut = true;
                    if (turnActive && currentTurnId) {
                        requireCtx().emit('turn.failed', {
                            turnId: currentTurnId,
                            status: 'failed',
                            code: 'Timeout',
                        }, { turnId: currentTurnId, inputId: currentInputId });
                        turnActive = false;
                    }
                    // Defer the RPC close to the next event-loop turn so a concurrent
                    // stop() (arriving from a same-tick timer) can pre-empt it.
                    // stop() clears turnTimeout, cancelling this deferred close.
                    turnTimeout = setTimeout(() => {
                        if (!stopping && !terminalEmitted) {
                            rpc?.close(new Error('Turn timed out'));
                        }
                    }, 0);
                }, turnTimeoutMs);
            }
            try {
                await rpc.sendRequest('turn/start', buildTurnStartParams({
                    threadId,
                    cwd: spec.process.cwd,
                    input,
                    driver: driverSpec,
                }));
            }
            catch (error) {
                if (turnTimeout !== undefined)
                    clearTimeout(turnTimeout);
                turnTimeout = undefined;
                if (turnTimedOut) {
                    if (stopping || terminalEmitted) {
                        return { ...(currentTurnId ? { turnId: currentTurnId } : {}) };
                    }
                    throw new BrokerError(BrokerErrorCode.Timeout, 'Turn timed out');
                }
                if (terminalEmitted || turnActive || stopping) {
                    return { ...(currentTurnId ? { turnId: currentTurnId } : {}) };
                }
                throw new BrokerError(BrokerErrorCode.HarnessError, error instanceof Error ? error.message : 'Codex turn failed to start');
            }
            if (turnTimeout !== undefined)
                clearTimeout(turnTimeout);
            turnTimeout = undefined;
            return { ...(currentTurnId ? { turnId: currentTurnId } : {}) };
        },
        async interrupt(req) {
            const reason = req.scope === 'turn'
                ? 'Codex app-server v0 does not support turn interrupt'
                : 'Codex app-server v0 interrupt unsupported';
            return {
                accepted: false,
                effect: 'unsupported',
                reason,
            };
        },
        async stop(req) {
            stopping = true;
            closeRendererControlListener();
            // Clear any pending turn timeout; the stop takes precedence.
            if (turnTimeout !== undefined) {
                clearTimeout(turnTimeout);
                turnTimeout = undefined;
            }
            if (!proc) {
                return { accepted: false, state: 'failed' };
            }
            await terminateProcess({
                proc,
                graceMs: req.graceMs ?? spec?.process.limits?.stopGraceMs ?? 1000,
            });
            return { accepted: true, state: terminalEmitted ? 'exited' : 'failed' };
        },
        async dispose() {
            closeRendererControlListener();
            closeTranscriptSidecar();
            reportedTranscriptPaths.clear();
            rpc?.close();
            ctx = undefined;
            spec = undefined;
            driverSpec = undefined;
            proc = undefined;
            rpc = undefined;
            threadId = undefined;
            currentInputId = undefined;
            currentTurnId = undefined;
            turnActive = false;
            startedEmitted = false;
            terminalEmitted = false;
            stopping = false;
            starting = false;
            rendererQuitAccepted = false;
        },
    };
    async function withStartupRace(work) {
        if (!startupFailure)
            return work;
        // Attach no-op catch to both sides so the loser doesn't trigger unhandled rejection
        work.catch(() => { });
        return Promise.race([work, startupFailure]);
    }
}
/**
 * Resolve the read-only observer/broker socket the renderer connects to for the
 * durable event surface. HRC supplies it via the
 * `HARNESS_BROKER_OBSERVER_SOCKET` dispatch/process env (the concrete read
 * endpoint seam); absent that, derive a conventional path beside the leased
 * tmux socket so the launch command always carries a concrete endpoint.
 */
function resolveRendererObserverSocket(driverCtx, surface) {
    const fromDispatch = driverCtx.dispatchEnv?.['HARNESS_BROKER_OBSERVER_SOCKET'];
    if (typeof fromDispatch === 'string' && fromDispatch.length > 0)
        return fromDispatch;
    const fromEnv = process.env['HARNESS_BROKER_OBSERVER_SOCKET'];
    if (typeof fromEnv === 'string' && fromEnv.length > 0)
        return fromEnv;
    const dir = surface.socketPath.includes('/')
        ? surface.socketPath.slice(0, surface.socketPath.lastIndexOf('/'))
        : '.';
    return `${dir}/${driverCtx.invocationId}.observer.sock`;
}
/**
 * Open a broker-owned sidecar JSONL file for raw provider-transcript rows.
 *
 * The directory is taken from a broker-owned artifact root on `dispatchEnv`
 * (`HARNESS_BROKER_ARTIFACT_DIR`, supplied by HRC in production) when present;
 * otherwise it falls back to a deterministic broker-owned subtree under the
 * system temp root. The path is always ABSOLUTE. The file is opened with `'w'`
 * so each invocation starts a fresh transcript (the path is per-invocation).
 */
function openTranscriptSidecar(ctx) {
    const fromDispatch = ctx.dispatchEnv?.['HARNESS_BROKER_ARTIFACT_DIR'];
    const dir = typeof fromDispatch === 'string' && fromDispatch.length > 0
        ? fromDispatch
        : DEFAULT_PROVIDER_TRANSCRIPT_DIR;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${ctx.invocationId}.provider-transcript.jsonl`);
    const fd = openSync(path, 'w');
    return { path, fd };
}
/**
 * Deterministic broker-owned fallback root for provider transcripts. A fixed
 * `/tmp`-rooted path (vs `mkdtemp`) keeps the absolute artifact path stable
 * per-invocation so durable goldens stay reproducible; HRC overrides it with a
 * runtime-owned artifact root via `HARNESS_BROKER_ARTIFACT_DIR`.
 */
const DEFAULT_PROVIDER_TRANSCRIPT_DIR = join(process.platform === 'win32' ? tmpdir() : '/tmp', 'spaces-harness-broker-provider-transcripts');
function buildRendererControlSocketPath(driverCtx, surface, runtimeId) {
    const dir = surface.socketPath.includes('/')
        ? surface.socketPath.slice(0, surface.socketPath.lastIndexOf('/'))
        : '.';
    return buildHookSocketPath(dir, 'codex-app-server-renderer-control', {
        invocationId: driverCtx.invocationId,
        runtimeId,
    });
}
/**
 * Tolerantly validate the Codex `initialize` handshake response.
 *
 * - A clearly-unsupported `protocolVersion` (a string that does not carry the
 *   `codex-app-server/` namespace) is a hard failure: throw HarnessError so the
 *   broker fails the invocation predictably rather than driving an incompatible
 *   server.
 * - A present-but-non-string `protocolVersion`, or a non-object response, is
 *   suspicious but non-critical — emit a `warn` diagnostic and continue.
 * - A missing `protocolVersion` is loose-but-common (do not overfit to the fake
 *   server) — emit a `debug` diagnostic and continue.
 */
export function validateInitializeHandshake(result, emitDiagnostic) {
    if (result === null || typeof result !== 'object') {
        emitDiagnostic('warn', 'Codex initialize response was not an object', {
            received: typeof result,
        });
        return;
    }
    const protocolVersion = result['protocolVersion'];
    if (typeof protocolVersion === 'string') {
        if (!protocolVersion.startsWith('codex-app-server/')) {
            throw new BrokerError(BrokerErrorCode.HarnessError, `Unsupported Codex app-server protocol version: ${protocolVersion}`, { protocolVersion });
        }
        return;
    }
    if (protocolVersion !== undefined) {
        emitDiagnostic('warn', 'Codex initialize protocolVersion was not a string', {
            received: typeof protocolVersion,
        });
        return;
    }
    emitDiagnostic('debug', 'Codex initialize response omitted protocolVersion');
}
/**
 * Build `thread/start` params from the driver spec. Every driver-spec field is
 * either forwarded to the native call or deliberately handled elsewhere:
 *  - model / approvalPolicy / sandboxMode: forwarded here.
 *  - profile: forwarded here (Codex app-server selects a config profile).
 *  - modelReasoningEffort: forwarded as a thread-scope `config` override here
 *    AND applied per-turn in buildTurnStartParams(effort).
 *  - defaultImageAttachments: applied per-turn in buildTurnStartParams.
 *  - resumeThreadId / resumeFallback / permissionPolicy: consumed by the driver
 *    resume + permission paths, not by thread/start.
 */
export function buildThreadStartParams(spec, driver) {
    return {
        model: driver.model ?? null,
        modelProvider: null,
        profile: driver.profile ?? null,
        cwd: spec.process.cwd,
        approvalPolicy: driver.approvalPolicy ?? 'never',
        sandbox: driver.sandboxMode ?? null,
        config: driver.modelReasoningEffort !== undefined
            ? { model_reasoning_effort: driver.modelReasoningEffort }
            : null,
        baseInstructions: null,
        developerInstructions: null,
        experimentalRawEvents: false,
    };
}
function extractThreadId(response) {
    const threadId = response?.threadId ?? response?.thread?.id;
    if (!threadId) {
        throw new BrokerError(BrokerErrorCode.HarnessError, 'Codex thread id missing after app-server thread start');
    }
    return threadId;
}
function isMissingThreadError(error) {
    if (!(error instanceof CodexRpcError)) {
        return false;
    }
    const code = extractErrorCode(error);
    return code === 'thread_missing' || /not found|no rollout found/i.test(error.message);
}
function extractErrorCode(error) {
    if (typeof error.data === 'string')
        return error.data;
    if (error.data !== null && typeof error.data === 'object') {
        const data = error.data;
        return typeof data['code'] === 'string' ? data['code'] : undefined;
    }
    return undefined;
}
//# sourceMappingURL=driver.js.map