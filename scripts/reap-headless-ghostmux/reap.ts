import { recordSpawn } from './process'
import { type Options, type PaneStatus, color } from './types'

export type ReapResult =
  | { kind: 'sent' }
  | { kind: 'dry-run' }
  | { kind: 'already-terminated'; message: string }
  | { kind: 'timed-out'; seconds: number }
  | { kind: 'error'; message: string }

// A reap whose target runtime is already gone (terminated/pruned between the
// status snapshot and the terminate call) is benign — the desired end state is
// already true. Recognize it so the loop logs a warning instead of aborting.
export function isAlreadyTerminatedError(message: string): boolean {
  return /runtime_unavailable|is terminated|already terminated|not found/i.test(message)
}

// Broker-backed operator reap (T-04423): instead of typing `/quit` into the
// live TUI prompt (timing-fragile keystroke injection), tear the broker-tmux
// runtime down deterministically over the broker RPC channel via the existing
// `hrc runtime terminate`. `--no-drop-continuation` preserves the session so the
// next turn resumes; `--reason operator_reap --source` stamps durable operator
// intent + attribution onto the `runtime.terminated` audit event.
//
// Returns a result instead of throwing: one runtime that fails to reap (already
// terminated, transient RPC error, etc.) must NOT abort the whole sweep — the
// caller warns and continues to the remaining eligible panes.
export function sendReap(status: PaneStatus, options: Options): ReapResult {
  const argv = [
    'hrc',
    'runtime',
    'terminate',
    status.runtimeId,
    '--no-drop-continuation',
    '--reason',
    'operator_reap',
    '--source',
    'close-headless-ghostmux',
  ]
  if (options.dryRun) {
    console.log(color.dim(`  dry-run: ${argv.join(' ')}`))
    return { kind: 'dry-run' }
  }
  // Bounded exec (NOT the shared `run()` helper, which is unbounded): a wedged
  // broker never acks the dispose RPC, and neither `hrc` nor its SDK fetch has a
  // timeout, so an unbounded spawnSync here freezes the entire sequential sweep.
  // On timeout, SIGTERM the hung `hrc` child and treat it as a benign warn — the
  // runtime stays `ready` with continuation intact, and the sweep moves on.
  const started = performance.now()
  const proc = Bun.spawnSync(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.reapTimeoutMs > 0 ? { timeout: options.reapTimeoutMs, killSignal: 'SIGTERM' } : {}),
  })
  recordSpawn(argv, performance.now() - started)
  return classifyReapExec(
    {
      exitedDueToTimeout: proc.exitedDueToTimeout,
      exitCode: proc.exitCode,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    },
    argv,
    options.reapTimeoutMs
  )
}

export type ReapExecOutcome = {
  exitedDueToTimeout?: boolean
  exitCode: number | null
  stdout: string
  stderr: string
}

// Pure classifier for a terminate exec result (unit-testable without spawning):
// a timeout (wedged broker, SIGTERM'd at the ceiling) is a benign warn so the
// sweep continues; exit 0 is success; a non-zero exit is already-terminated
// (benign) or a genuine error.
export function classifyReapExec(
  outcome: ReapExecOutcome,
  argv: string[],
  timeoutMs: number
): ReapResult {
  if (outcome.exitedDueToTimeout) {
    return { kind: 'timed-out', seconds: Math.round(timeoutMs / 1000) }
  }
  if (outcome.exitCode === 0) return { kind: 'sent' }
  const message = `${argv.join(' ')} failed (${outcome.exitCode}): ${
    outcome.stderr || outcome.stdout
  }`
  return isAlreadyTerminatedError(message)
    ? { kind: 'already-terminated', message }
    : { kind: 'error', message }
}
