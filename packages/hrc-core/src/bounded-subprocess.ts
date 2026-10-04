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
 * It lives in hrc-core so placement code there can use it; hrc-server
 * re-exports it. `scripts/check-daemon-subprocess.ts` refuses raw spawns in
 * daemon code and names this module.
 */

import type { Subprocess } from 'bun'

export class SubprocessTimeoutError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly timeoutMs: number
  ) {
    super(`${argv[0] ?? 'subprocess'} exceeded ${timeoutMs}ms and was terminated`)
    this.name = 'SubprocessTimeoutError'
  }
}

/** The child wrote more stdout than `maxStdoutBytes`; it was killed. */
export class SubprocessOutputLimitError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly maxStdoutBytes: number,
    readonly stdoutBytes: number
  ) {
    super(
      `${argv[0] ?? 'subprocess'} wrote more than ${maxStdoutBytes} stdout bytes and was terminated`
    )
    this.name = 'SubprocessOutputLimitError'
  }
}

export type BoundedSubprocessResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  /** The signal that ended the child, if one did (exitCode is then 128 + its number). */
  signalCode: string | null
  /** Bytes read from stdout (0 when stdout is ignored). */
  stdoutBytes: number
}

export type BoundedSubprocessOptions = {
  timeoutMs: number
  env?: Record<string, string | undefined> | undefined
  cwd?: string | undefined
  /** Written to the child's stdin, which is then closed. Absent: stdin is ignored. */
  stdin?: string | undefined
  /** 'ignore' discards stdout instead of buffering it. */
  stdout?: 'pipe' | 'ignore' | undefined
  /** Kill the child and reject with SubprocessOutputLimitError past this many stdout bytes. */
  maxStdoutBytes?: number | undefined
  /** Keep only the last this-many characters of stderr. */
  stderrTailChars?: number | undefined
  /**
   * Run the child as the leader of its own process group and kill the whole
   * group, so helper grandchildren (shell wrappers, interpreters) cannot
   * outlive a timeout.
   */
  processGroup?: boolean | undefined
  /** Called with the child's pid once it exists (e.g. to reap it at server stop). */
  onSpawn?: ((pid: number) => void) | undefined
}

/** SIGKILL the child, or its whole process group. Never throws. */
export function killSubprocess(pid: number, processGroup: boolean): void {
  if (processGroup) {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // Fall through to the leader alone.
    }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/**
 * Read until EOF or `stop`. Stopping cancels the stream, which closes our end
 * of the pipe: a writer the kill did not reach (a background grandchild when
 * processGroup is unset) then dies of SIGPIPE instead of being drained for the
 * rest of the process's life.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
  stop: AbortSignal
): Promise<void> {
  const reader = stream.getReader()
  const cancel = () => {
    reader.cancel().catch(() => {})
  }
  stop.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || stop.aborted) return
      onChunk(value)
    }
  } finally {
    stop.removeEventListener('abort', cancel)
  }
}

export async function runBoundedSubprocess(
  argv: readonly string[],
  options: BoundedSubprocessOptions
): Promise<BoundedSubprocessResult> {
  const processGroup = options.processGroup === true
  const signal = AbortSignal.timeout(options.timeoutMs)
  const proc = Bun.spawn([...argv], {
    env: options.env ?? process.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: options.stdin === undefined ? 'ignore' : 'pipe',
    stdout: options.stdout === 'ignore' ? 'ignore' : 'pipe',
    stderr: 'pipe',
    signal,
    ...(processGroup ? { detached: true } : {}),
  })
  options.onSpawn?.(proc.pid)

  let rejectLimit: (error: Error) => void = () => {}
  const failure = new Promise<never>((_, reject) => {
    rejectLimit = reject
    signal.addEventListener(
      'abort',
      () => reject(new SubprocessTimeoutError(argv, options.timeoutMs)),
      { once: true }
    )
  })
  // The loser of the race always settles; swallow it so it is never an
  // unhandled rejection.
  failure.catch(() => {})

  if (options.stdin !== undefined && proc.stdin !== undefined) {
    try {
      proc.stdin.write(options.stdin)
      await proc.stdin.end()
    } catch {
      // The child closed stdin early; its exit status says why.
    }
  }

  const stopReading = new AbortController()
  const decoder = new TextDecoder()
  let stdout = ''
  let stdoutBytes = 0
  const readStdout =
    proc.stdout instanceof ReadableStream
      ? readCapped(
          proc.stdout,
          (chunk) => {
            stdoutBytes += chunk.byteLength
            if (options.maxStdoutBytes !== undefined && stdoutBytes > options.maxStdoutBytes) {
              rejectLimit(new SubprocessOutputLimitError(argv, options.maxStdoutBytes, stdoutBytes))
              stopReading.abort()
              return
            }
            stdout += decoder.decode(chunk, { stream: true })
          },
          stopReading.signal
        )
      : Promise.resolve()
  const stderrDecoder = new TextDecoder()
  let stderr = ''
  const readStderr = readCapped(
    proc.stderr,
    (chunk) => {
      stderr += stderrDecoder.decode(chunk, { stream: true })
      if (options.stderrTailChars !== undefined && stderr.length > options.stderrTailChars) {
        stderr = stderr.slice(-options.stderrTailChars)
      }
    },
    stopReading.signal
  )

  let exitCode: number | null
  try {
    ;[, , exitCode] = await Promise.race([
      Promise.all([readStdout, readStderr, proc.exited]),
      failure,
    ])
  } catch (error) {
    // SIGTERM is what the AbortSignal already sent; escalate rather than leave
    // a wedged child holding the pipes.
    killSubprocess(proc.pid, processGroup)
    stopReading.abort()
    throw error
  }

  // Check the signal BEFORE the exit code: an aborted process exits non-zero
  // with stale stderr.
  if (signal.aborted) throw new SubprocessTimeoutError(argv, options.timeoutMs)
  stdout += decoder.decode()
  stderr += stderrDecoder.decode()
  return { stdout, stderr, exitCode, signalCode: proc.signalCode ?? null, stdoutBytes }
}

export type LongLivedSubprocess = Subprocess<'pipe', 'pipe', 'pipe'>

/**
 * A child that is meant to stay up (a JSON-RPC transport over stdio) cannot be
 * bounded by one deadline on its whole life. Its contract instead: the caller
 * bounds EVERY request it sends with its own timer, and a request that misses
 * its timer kills this child, so a wedge costs one request budget and the next
 * call gets a fresh child. Use runBoundedSubprocess for anything that exits.
 */
export function spawnLongLivedSubprocess(
  argv: readonly string[],
  options: { env?: Record<string, string | undefined> | undefined }
): LongLivedSubprocess {
  return Bun.spawn([...argv], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: options.env ?? process.env,
  })
}
