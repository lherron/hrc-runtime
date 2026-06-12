import { type ExecProcess, type ExecProcessResult, execProcess } from './consul-secrets.js'

/**
 * Reads the live wrkq state for a task id (e.g. "T-04216") at terminal-frame
 * build time so a stacked coordinator can see per-task truth alongside the
 * per-turn `result`. Read-only: shells out to `wrkq cat <taskId> --json`.
 *
 * Returns the state string (e.g. "completed" | "in_progress" | "open") or
 * `null` when the task is not found, wrkq is unavailable, or the output cannot
 * be parsed. Never throws — enrichment must not fail the frame.
 */
export async function readTaskState(
  taskId: string,
  runProcess: ExecProcess = execProcess
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
