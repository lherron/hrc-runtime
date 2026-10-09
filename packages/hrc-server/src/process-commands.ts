import { runBoundedSubprocess } from './bounded-subprocess.js'

/** Machine-wide `ps` answers in well under a second; the bound is for a wedged process table. */
const PS_LIST_TIMEOUT_MS = 5_000

/**
 * Every process's argv on this node. Rejects on a timeout or failure, so a
 * caller using it as negative evidence must treat a rejection as "unknown",
 * never as "no such process".
 */
export async function listProcessCommands(): Promise<string[]> {
  const { stdout, stderr, exitCode } = await runBoundedSubprocess(['ps', '-axo', 'command='], {
    timeoutMs: PS_LIST_TIMEOUT_MS,
  })
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ps exited with status ${exitCode}`)
  }
  return stdout.split('\n').filter(Boolean)
}
