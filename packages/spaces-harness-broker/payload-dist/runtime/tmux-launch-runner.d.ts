#!/usr/bin/env bun
import type { TmuxLaunchExecPrompts } from './tmux-launch-exec';
/**
 * Frame-print the launch header to stdout. Best-effort: a missing or unreadable
 * system-prompt file must never block the launch. No-op when there is nothing
 * to frame (e.g. routes that carry no prompt material).
 */
export declare function printLaunchHeader(prompts: TmuxLaunchExecPrompts | undefined, env: Record<string, string>): Promise<void>;
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
export declare function postSyntheticSessionEnd(env: Record<string, string>, code: number | null, signal: NodeJS.Signals | null): Promise<void>;
/** Read the launch artifact, print the header, spawn the harness, and mirror its exit. */
export declare function runTmuxLaunch(launchFilePath: string): Promise<never>;
//# sourceMappingURL=tmux-launch-runner.d.ts.map