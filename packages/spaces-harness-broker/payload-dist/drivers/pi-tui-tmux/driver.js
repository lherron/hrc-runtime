import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BrokerErrorCode, CONSERVATIVE_LIFECYCLE_CAPABILITIES, } from 'spaces-harness-broker-protocol';
import { BrokerError } from '../../errors';
import { writeTmuxLaunchExecFiles } from '../../runtime/tmux-launch-exec';
import { buildHookSocketPath, consumePaneLease, extractText, getInvocationRuntimeId, listenForHookEnvelopes, shellQuote, sleep, } from '../tmux-shared';
import { PI_TUI_TMUX_DRIVER_KIND, createPiTuiTmuxHookEventNormalizer, normalizePiHookEnvelope, } from './hook-events';
const PI_TUI_TMUX_DRIVER_VERSION = '0.1.0';
const PI_HOOK_GENERATION = 1;
const INPUT_SUBMIT_GAP_MS = 1_000;
const PI_TUI_TMUX_CAPABILITIES = {
    input: {
        user: true,
        steer: false,
        appendContext: false,
        localImages: false,
        fileRefs: false,
        queue: true,
    },
    turns: {
        concurrency: 'single',
        interrupt: 'process',
    },
    continuation: {
        supported: true,
        provider: 'openai',
        keyKind: 'session',
    },
    events: {
        assistantDeltas: true,
        toolCalls: true,
        usage: false,
        diagnostics: true,
    },
    control: {
        stop: true,
        dispose: true,
        attach: true,
        driverAttachExistingSurface: false,
    },
    lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
};
export function createPiTuiTmuxDriver(options) {
    const now = options.now ?? (() => new Date());
    let ctx;
    let surface;
    let hookListener;
    let hookDrain = Promise.resolve();
    let paneController;
    let activeTurnId;
    let turnCounter = 0;
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
    async function deliverInput(input) {
        requireCtx();
        requireSurface();
        const controller = requirePaneController();
        await controller.sendLiteral(extractText(input));
        await sleep(INPUT_SUBMIT_GAP_MS);
        await controller.sendEnter();
    }
    return {
        kind: PI_TUI_TMUX_DRIVER_KIND,
        version: PI_TUI_TMUX_DRIVER_VERSION,
        capabilities() {
            return PI_TUI_TMUX_CAPABILITIES;
        },
        async start(spec, driverCtx) {
            const leased = await consumePaneLease(driverCtx, {
                driverKind: PI_TUI_TMUX_DRIVER_KIND,
                ...(options.tmux.tmuxBin !== undefined ? { tmuxBin: options.tmux.tmuxBin } : {}),
                ...(options.tmux.exec !== undefined ? { exec: options.tmux.exec } : {}),
            });
            ctx = driverCtx;
            paneController = leased.controller;
            surface = leased.surface;
            const expectedRuntimeId = getInvocationRuntimeId(spec);
            const normalizer = createPiTuiTmuxHookEventNormalizer({
                invocationId: driverCtx.invocationId,
                now,
                allocateTurnId,
            });
            hookDrain = Promise.resolve();
            const handleHookEnvelope = (envelope) => {
                if (envelope.invocationId !== driverCtx.invocationId)
                    return;
                if (expectedRuntimeId !== undefined &&
                    envelope.runtimeId !== undefined &&
                    envelope.runtimeId !== expectedRuntimeId) {
                    return;
                }
                if (envelope.generation !== undefined && envelope.generation !== PI_HOOK_GENERATION) {
                    return;
                }
                if (hookListener !== undefined && envelope.callbackSocket !== hookListener.socketPath) {
                    return;
                }
                const effectiveEnvelope = envelope.turnId === undefined && activeTurnId !== undefined
                    ? { ...envelope, turnId: activeTurnId }
                    : envelope;
                for (const event of normalizePiHookEnvelope(effectiveEnvelope, { normalizer })) {
                    driverCtx.emit(event.type, event.payload, {
                        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
                        ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
                        ...(event.driver !== undefined ? { driver: event.driver } : {}),
                    });
                    if (event.type === 'turn.started' && event.turnId !== undefined) {
                        activeTurnId = event.turnId;
                    }
                    else if (event.type === 'turn.completed' && activeTurnId === event.turnId) {
                        activeTurnId = undefined;
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
            const lease = leased.surface;
            driverCtx.emit('terminal.surface.reported', {
                kind: 'tmux-pane',
                socketPath: lease.socketPath,
                sessionId: lease.sessionId,
                windowId: lease.windowId,
                paneId: lease.paneId,
                ...(lease.sessionName !== undefined ? { sessionName: lease.sessionName } : {}),
                ...(lease.windowName !== undefined ? { windowName: lease.windowName } : {}),
            }, { driver: { kind: PI_TUI_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } });
            const hookCliPath = await writePiHookBridgeWrapper({
                callbackSocket: hookListener.socketPath,
                bridgeCommand: options.hooks.bridgeCommand,
            });
            const launchCommand = await buildLaunchCommandLine(spec, driverCtx, {
                callbackSocket: hookListener.socketPath,
                hookCliPath,
                ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
            });
            await paneController.sendPastedLine(launchCommand);
            return { ok: true };
        },
        async applyInputNow(input) {
            const turnId = allocateTurnId();
            activeTurnId = turnId;
            await deliverInput(input);
            return { turnId: turnId };
        },
        async applySteerNow(input) {
            await deliverInput(input);
        },
        async interrupt(_req) {
            if (surface === undefined || paneController === undefined) {
                return { accepted: false, effect: 'no_active_turn' };
            }
            await paneController.interrupt();
            return { accepted: true, effect: 'turn_interrupted' };
        },
        async stop(_req) {
            await closeHookListener();
            surface = undefined;
            return { accepted: true, state: 'exited' };
        },
        async dispose() {
            await closeHookListener();
            ctx = undefined;
            surface = undefined;
            paneController = undefined;
            activeTurnId = undefined;
        },
    };
    async function closeHookListener() {
        await hookDrain.catch(() => undefined);
        if (hookListener !== undefined) {
            const handle = hookListener;
            hookListener = undefined;
            await handle.close();
        }
    }
}
async function buildLaunchCommandLine(spec, ctx, hookEnv) {
    const env = {
        ...spec.process.lockedEnv,
        ...(ctx.dispatchEnv ?? {}),
        HRC_LAUNCH_HOOK_CLI: hookEnv.hookCliPath,
        HARNESS_BROKER_INVOCATION_ID: ctx.invocationId,
        HARNESS_BROKER_CALLBACK_SOCKET: hookEnv.callbackSocket,
        HARNESS_BROKER_HOOK_GENERATION: String(PI_HOOK_GENERATION),
        ...(hookEnv.runtimeId !== undefined ? { HARNESS_BROKER_RUNTIME_ID: hookEnv.runtimeId } : {}),
    };
    const launch = await writeTmuxLaunchExecFiles(`${hookEnv.callbackSocket}.pi`, {
        argv: [spec.process.command, ...spec.process.args],
        cwd: spec.process.cwd,
        env,
        ...(spec.launch !== undefined ? { prompts: spec.launch } : {}),
    });
    return launch.commandLine;
}
const DEFAULT_HOOK_BRIDGE_COMMAND = 'harness-broker pi-hook';
async function writePiHookBridgeWrapper(options) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const bridge = options.bridgeCommand ?? DEFAULT_HOOK_BRIDGE_COMMAND;
    const wrapperPath = `${options.callbackSocket}.pi-hook.ts`;
    const shellCommand = `${bridge} --socket ${shellQuote(options.callbackSocket)}`;
    await mkdir(dirname(wrapperPath), { recursive: true });
    await writeFile(wrapperPath, [
        '#!/usr/bin/env bun',
        "import { spawn } from 'node:child_process'",
        '',
        `const child = spawn('/bin/sh', ['-lc', ${JSON.stringify(`exec ${shellCommand}`)}], {`,
        "  stdio: 'inherit',",
        '  env: process.env,',
        '})',
        "child.on('error', (error) => {",
        '  process.stderr.write(`pi-hook wrapper failed: ${error instanceof Error ? error.message : String(error)}\\n`)',
        '  process.exit(0)',
        '})',
        "child.on('exit', (code, signal) => {",
        '  if (signal) process.kill(process.pid, signal)',
        '  else process.exit(code ?? 0)',
        '})',
        '',
    ].join('\n'), 'utf8');
    return wrapperPath;
}
export function createDefaultPiTuiTmuxDriver(socketDir = join(tmpdir(), 'harness-broker')) {
    return createPiTuiTmuxDriver({
        tmux: {},
        hooks: {
            listen: (handler, context) => listenForHookEnvelopes(buildPiHookSocketPath(socketDir, context), handler),
        },
    });
}
export function buildPiHookSocketPath(socketDir, context) {
    return buildHookSocketPath(socketDir, 'pi-hooks', context);
}
//# sourceMappingURL=driver.js.map