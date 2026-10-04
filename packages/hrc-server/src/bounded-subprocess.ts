/**
 * The daemon's one way to run a subprocess and read its output (T-10226).
 *
 * The daemon is one event loop serving every runtime, so a child it waits on
 * must not be able to hold it. Each way that has gone wrong is closed here:
 *
 * - a synchronous spawn blocks every request for the child's whole life
 *   (`wrkq projects` / `git worktree list` on placement paths, 9db3c633);
 * - an armed-but-not-raced deadline does not end the wait: killing the child
 *   leaves the pipe write end held by anything it spawned, so awaiting stdout
 *   EOF inherits the slowest holder's lifetime (a 250ms budget took 5s,
 *   0960fbc3);
 * - a SIGTERM to a child stuck in an uninterruptible call does not land, so
 *   the kill escalates to SIGKILL (b2ecc48f);
 * - a killed child's stderr describes what it printed before the kill, so a
 *   timeout is reported as its own type, never as the child's stderr.
 *
 * `scripts/check-daemon-subprocess.ts` refuses new raw spawns in daemon code
 * and names this module.
 */

export class SubprocessTimeoutError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly timeoutMs: number
  ) {
    super(`${argv[0] ?? 'subprocess'} exceeded ${timeoutMs}ms and was terminated`)
    this.name = 'SubprocessTimeoutError'
  }
}

export type BoundedSubprocessResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

export async function runBoundedSubprocess(
  argv: readonly string[],
  options: {
    timeoutMs: number
    env?: Record<string, string | undefined> | undefined
    cwd?: string | undefined
  }
): Promise<BoundedSubprocessResult> {
  const signal = AbortSignal.timeout(options.timeoutMs)
  const proc = Bun.spawn([...argv], {
    env: options.env ?? process.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  })

  const deadline = new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new SubprocessTimeoutError(argv, options.timeoutMs)),
      { once: true }
    )
  })
  // The loser of the race always settles; swallow it so it is never an
  // unhandled rejection.
  deadline.catch(() => {})

  let stdout: string
  let stderr: string
  let exitCode: number | null
  try {
    ;[stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      deadline,
    ])
  } catch (error) {
    // SIGTERM is what the AbortSignal already sent; escalate rather than leave
    // a wedged child holding the pipes.
    try {
      proc.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    throw error
  }

  // Check the signal BEFORE the exit code: an aborted process exits non-zero
  // with stale stderr.
  if (signal.aborted) throw new SubprocessTimeoutError(argv, options.timeoutMs)
  return { stdout, stderr, exitCode }
}
