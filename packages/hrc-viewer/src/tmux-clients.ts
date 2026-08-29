/**
 * Who is ALREADY watching a broker runtime's TUI (T-07711).
 *
 * `invocation.operatorAttachPending` on a `runtime.presentation` event only ever
 * says "THIS invocation's terminal will attach". A foreign dispatch — another
 * agent's `wrkc say` landing on a runtime an operator is already attached to —
 * cannot carry it, so it publishes `false`, the monotone `viewerRequested` flips
 * true, and the viewer used to mint a second Ghostty window on top of the
 * operator's live `hrc run`. This probe asks the question nothing in that chain
 * asked: is somebody already attached to this tmux target?
 *
 * It is consulted ONLY on the create branch, where the viewer holds no pane of
 * its own for the runtime — so any attached client is by construction some OTHER
 * terminal, i.e. an operator. That is what makes a bare client count a sound
 * discriminator here and nowhere else.
 *
 * Fails OPEN by contract: only a positive, non-empty client list suppresses a
 * create. A tmux error, a missing socket, a dead session, a timeout, or
 * unparsable output all answer `[]` and the viewer creates as before — silently
 * losing a viewer is worse than a duplicate window.
 */

/** Bounded so a wedged tmux server cannot stall the create path. */
export const DEFAULT_TMUX_CLIENT_PROBE_TIMEOUT_MS = 2_000

/**
 * Attached client ttys for one tmux target, or `[]` for every negative and
 * indeterminate answer. Never throws (see the fail-open contract above).
 */
export type TmuxClientProbe = (
  socketPath: string,
  attachTarget: string
) => Promise<readonly string[]>

/** One tty per line; blank lines dropped. */
export function parseTmuxClientList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export function createTmuxClientProbe(
  options: {
    tmuxBin?: string | undefined
    timeoutMs?: number | undefined
  } = {}
): TmuxClientProbe {
  const tmuxBin = options.tmuxBin ?? 'tmux'
  const timeoutMs = Math.max(
    1,
    Math.trunc(options.timeoutMs ?? DEFAULT_TMUX_CLIENT_PROBE_TIMEOUT_MS)
  )

  return async (socketPath, attachTarget) => {
    // `-t` scopes the answer to the session behind the attach target, so a
    // client attached to some other session on the same server never counts.
    const args = ['-S', socketPath, 'list-clients', '-t', attachTarget, '-F', '#{client_tty}']
    try {
      const proc = Bun.spawn([tmuxBin, ...args], {
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = new Response(proc.stdout).text()
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // Already exited concurrently with the deadline.
        }
      }, timeoutMs)
      try {
        const [exitCode, rendered] = await Promise.all([proc.exited, stdout])
        // A non-zero tmux (no server, no such session) is a negative answer,
        // not a reason to suppress: fall through to the fail-open `[]`.
        if (exitCode !== 0) return []
        return parseTmuxClientList(rendered)
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return []
    }
  }
}
