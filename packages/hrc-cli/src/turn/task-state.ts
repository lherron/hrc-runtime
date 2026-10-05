import { runBoundedSubprocess } from 'hrc-core'

export type ExecProcessResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type ExecProcess = (argv: string[]) => Promise<ExecProcessResult>

/**
 * `wrkq cat` answers in well under a second; the bound is for a wedged or
 * unreachable ledger, which must cost the final frame a few seconds at most
 * (T-10244).
 */
export const TASK_STATE_TIMEOUT_MS = 3_000

/** An ExecProcess that kills the child past `timeoutMs` and rejects. */
export function boundedProcess(
  timeoutMs: number,
  env?: Record<string, string | undefined>
): ExecProcess {
  return async (argv) => {
    const result = await runBoundedSubprocess(argv, { timeoutMs, env, processGroup: true })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 }
  }
}

/**
 * Reads the live wrkq state for a task id (e.g. "T-04216") at terminal-frame
 * build time so a stacked coordinator can see per-task truth alongside the
 * per-turn `result`. Read-only: shells out to `wrkq cat <taskId> --json`.
 *
 * Returns the state string (e.g. "completed" | "in_progress" | "open") or
 * `null` when the task is not found, wrkq is unavailable or too slow, or the
 * output cannot be parsed. Never throws — enrichment must not fail the frame.
 */
export async function readTaskState(
  taskId: string,
  runProcess: ExecProcess = boundedProcess(TASK_STATE_TIMEOUT_MS)
): Promise<string | null> {
  let result: ExecProcessResult
  try {
    result = await runProcess(['wrkq', 'cat', taskId, '--json'])
  } catch {
    return null
  }

  if (result.exitCode !== 0) {
    return null
  }

  try {
    // `wrkq cat --json` emits an array of task records; the requested task is
    // the first (and only) element.
    const parsed: unknown = JSON.parse(result.stdout)
    const record = Array.isArray(parsed) ? parsed[0] : parsed
    if (typeof record === 'object' && record !== null) {
      const state = (record as Record<string, unknown>)['state']
      if (typeof state === 'string' && state.length > 0) {
        return state
      }
    }
  } catch {
    return null
  }

  return null
}
