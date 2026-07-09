#!/usr/bin/env bun
/**
 * Real launch runner for tmux broker routes. Invoked by absolute path
 * (`exec bun <this-file> --launch-file <json>`) inside the tmux pane: it reads
 * the launch artifact written by writeTmuxLaunchExecFiles, frame-prints the
 * launch header (system prompt + priming + key env) so the operator sees the
 * same context the legacy hrc launch printed, then spawns the harness with
 * stdio inherited.
 *
 * This is a normal module (not generated code): the launch wrapper used to be a
 * hard-coded JS string, which was untestable and unlintable. The generated
 * artifact is now pure JSON data; all behavior lives here.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
const FRAME_WIDTH = 72;
/** Key env vars surfaced in the launch header, mirroring the legacy hrc display. */
const HEADER_ENV_KEYS = ['AGENTCHAT_ID', 'ASP_PROJECT', 'AGENTCHAT_TRANSPORT'];
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
/** Render one framed prompt section (mirrors execution/prompt-display.ts renderSection). */
function renderSection(title, content, colorCode) {
    const color = (s) => `\x1b[${colorCode}m${s}\x1b[0m`;
    const lines = [];
    const titleSegment = `─ ${title} `;
    const topRule = '─'.repeat(Math.max(0, FRAME_WIDTH - titleSegment.length - 1));
    lines.push(color(`┌${titleSegment}`) + dim(topRule));
    lines.push(dim('│'));
    for (const line of content.split('\n')) {
        lines.push(dim('│  ') + line);
    }
    lines.push(dim('│'));
    const meta = ` ${content.length.toLocaleString()} chars`;
    const bottomRule = '─'.repeat(Math.max(0, FRAME_WIDTH - meta.length - 1));
    lines.push(dim(`└${bottomRule}`) + dim(meta));
    return lines;
}
/**
 * Frame-print the launch header to stdout. Best-effort: a missing or unreadable
 * system-prompt file must never block the launch. No-op when there is nothing
 * to frame (e.g. routes that carry no prompt material).
 */
export async function printLaunchHeader(prompts, env) {
    if (prompts === undefined) {
        return;
    }
    const out = [];
    let systemPrompt;
    if (typeof prompts.systemPromptFile === 'string') {
        try {
            systemPrompt = await readFile(prompts.systemPromptFile, 'utf8');
        }
        catch {
            systemPrompt = undefined;
        }
    }
    if (systemPrompt !== undefined && systemPrompt.length > 0) {
        const mode = prompts.systemPromptMode === 'append' ? 'append' : 'replace';
        out.push('');
        out.push(...renderSection(`System Prompt (${mode})`, systemPrompt, '36'));
    }
    if (typeof prompts.initialPrompt === 'string' && prompts.initialPrompt.length > 0) {
        out.push('');
        out.push(...renderSection('Priming Prompt', prompts.initialPrompt, '35'));
    }
    const envEntries = HEADER_ENV_KEYS.filter((key) => env[key]).map((key) => `  ${key}=${env[key]}`);
    if (envEntries.length > 0) {
        out.push('');
        out.push(dim('─ env ─'));
        out.push(...envEntries.map((entry) => dim(entry)));
    }
    if (out.length > 0) {
        process.stdout.write(`${out.join('\n')}\n\n`);
    }
}
function envFromArtifact(artifact) {
    const env = {};
    for (const [key, value] of Object.entries(artifact.env ?? {})) {
        if (typeof value === 'string') {
            env[key] = value;
        }
    }
    return env;
}
/**
 * Best-effort: post one synthetic `SessionEnd` envelope to the broker's hook
 * callback socket when the harness process exits.
 *
 * Codex CLI emits NO upstream signal on `/quit` — no SessionEnd hook, no
 * session-end OTEL event; `/quit` is a shutdown-first clean process exit. The
 * Claude tmux driver gets its teardown from Claude's own SessionEnd hook
 * (→ continuation.cleared → HRC reaps the broker-tmux lease → operator detaches).
 * To give codex the same teardown without a pane-death watcher, we stand on the
 * one signal codex DOES give — its process exiting — which the launch runner
 * already holds via `child.on('exit')`. We synthesize the SessionEnd here and
 * post it on the SAME per-invocation callback socket the codex hook bridge uses,
 * carrying the identity fields (invocation/runtime/generation/socket) so the
 * driver's durable-identity fence accepts it. Reason mirrors Claude's semantics:
 * a clean exit (`/quit`) is `prompt_input_exit` (drop continuation, reap); a
 * crash/signal is `other` (keep the continuation so resume durability survives —
 * T-01761). Gated by HARNESS_BROKER_SYNTH_SESSION_END so only the codex driver
 * opts in; the claude driver, which fires a real SessionEnd, is untouched.
 */
export async function postSyntheticSessionEnd(env, code, signal) {
    const socketPath = env['HARNESS_BROKER_CALLBACK_SOCKET'];
    const invocationId = env['HARNESS_BROKER_INVOCATION_ID'];
    if (!socketPath || !invocationId) {
        return;
    }
    const reason = signal === null && code === 0 ? 'prompt_input_exit' : 'other';
    const generationRaw = env['HARNESS_BROKER_HOOK_GENERATION'];
    const generation = generationRaw !== undefined && generationRaw !== '' && Number.isFinite(Number(generationRaw))
        ? Number(generationRaw)
        : undefined;
    const runtimeId = env['HARNESS_BROKER_RUNTIME_ID'];
    const envelope = {
        invocationId,
        ...(runtimeId ? { runtimeId } : {}),
        ...(generation !== undefined ? { generation } : {}),
        callbackSocket: socketPath,
        hookData: { hook_event_name: 'SessionEnd', reason },
    };
    await new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        const timer = setTimeout(done, 1000);
        timer.unref?.();
        try {
            const conn = connect(socketPath, () => {
                conn.end(JSON.stringify(envelope));
            });
            conn.on('error', () => {
                clearTimeout(timer);
                done();
            });
            conn.on('close', () => {
                clearTimeout(timer);
                done();
            });
        }
        catch {
            clearTimeout(timer);
            done();
        }
    });
}
/** Read the launch artifact, print the header, spawn the harness, and mirror its exit. */
export async function runTmuxLaunch(launchFilePath) {
    const artifact = JSON.parse(await readFile(launchFilePath, 'utf8'));
    const argv = Array.isArray(artifact.argv) ? artifact.argv : [];
    const command = argv[0];
    if (typeof command !== 'string' || command.length === 0) {
        process.stderr.write('harness-broker tmux launch: empty argv in launch artifact\n');
        process.exit(1);
    }
    const env = envFromArtifact(artifact);
    await printLaunchHeader(artifact.prompts, env);
    const child = spawn(command, argv.slice(1), {
        cwd: typeof artifact.cwd === 'string' ? artifact.cwd : process.cwd(),
        env: { ...process.env, ...env },
        stdio: 'inherit',
    });
    return await new Promise(() => {
        child.on('error', (error) => {
            process.stderr.write(`harness-broker tmux launch failed: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exit(1);
        });
        child.on('exit', (code, signal) => {
            void (async () => {
                // Synthesize the harness-exit teardown signal for drivers that opt in
                // (codex, which emits no SessionEnd hook of its own). Awaited so the
                // envelope flushes to the broker socket before we mirror the exit.
                if (env['HARNESS_BROKER_SYNTH_SESSION_END']) {
                    await postSyntheticSessionEnd(env, code, signal);
                }
                if (signal) {
                    process.kill(process.pid, signal);
                }
                else {
                    process.exit(code ?? 0);
                }
            })();
        });
    });
}
async function main() {
    const flagIndex = process.argv.indexOf('--launch-file');
    const launchFilePath = flagIndex === -1 ? undefined : process.argv[flagIndex + 1];
    if (!launchFilePath) {
        process.stderr.write('harness-broker tmux launch: missing --launch-file\n');
        process.exit(1);
    }
    await runTmuxLaunch(launchFilePath);
}
if (import.meta.main) {
    await main();
}
//# sourceMappingURL=tmux-launch-runner.js.map