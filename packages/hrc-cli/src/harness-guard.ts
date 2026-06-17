/**
 * Refuse to boot hrc-server in the foreground from inside a coding-agent harness.
 *
 * A server started as a child of a harness (Claude Code, Codex, …) inherits that
 * harness's recursion-guard environment variables. It then leaks them into every
 * child harness it launches, so those children hit their own "no nested agent"
 * guard and fail to start — every dispatched run dies silently.
 *
 * The supported boot paths never trip this: `hrc server start`/`restart` delegate
 * to launchd, which respawns the daemon with a clean environment. This guard only
 * fires when the server process itself is a descendant of a live agent harness.
 *
 * Pure and env-injected so it is unit-testable without mutating process.env.
 */

/** Env vars whose presence means we are running inside a coding-agent harness. */
const HARNESS_GUARD_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
] as const

/** The harness guard vars that are set (non-empty) in `env`, in stable order. */
export function detectAgentHarnessEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): string[] {
  return HARNESS_GUARD_VARS.filter((key) => {
    const value = env[key]
    return value !== undefined && value !== ''
  })
}

/**
 * The refusal message if `env` indicates a coding-agent harness parent, else null.
 * Names the detected vars so the agent reader knows the refusal is deterministic.
 * There is intentionally no escape hatch: an env override is exactly what an agent
 * would reach for to make the error go away, reintroducing the footgun.
 */
export function agentHarnessGuardMessage(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): string | null {
  const detected = detectAgentHarnessEnv(env)
  if (detected.length === 0) {
    return null
  }

  return (
    `hrc server: refusing to boot in the foreground — this process is running inside a\n` +
    `coding-agent harness (detected: ${detected.join(', ')}).\n` +
    `\n` +
    `A server started here inherits the harness's recursion-guard variables and leaks\n` +
    `them into every child agent it launches. Those children hit the harness's\n` +
    `"no nested agent" guard and fail to start — so every run you dispatch dies silently.\n` +
    `\n` +
    `Do NOT start hrc-server as a child of a coding-agent harness. Instead:\n` +
    `  • Already managed by launchd?  ->  hrc server restart   (the supported path; runs clean under launchd)\n` +
    `  • Need a fresh foreground boot?  ->  launch it in a real terminal outside this session\n` +
    `                                       (e.g. drive a clean Ghostty pane with ghostmux)`
  )
}
