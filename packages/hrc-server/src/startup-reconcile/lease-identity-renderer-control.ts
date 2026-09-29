import { readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { writeServerLog } from '../server-log.js'
import type {
  RendererControlSocketSweepOptions,
  RendererControlSocketSweepResult,
} from './types.js'

/**
 * Ceiling on the single machine-wide `lsof -U` holder enumeration.
 *
 * Two reasons this is well under ten seconds. It runs on the daemon's STARTUP
 * critical path for a best-effort cleanup whose documented failure mode is
 * "preserve every candidate", so it must never be able to add ten seconds to
 * `createHrcServer`. And the hrc-server suite runs `bun test --timeout 10000`:
 * at an equal ten seconds the abort branch below was unreachable from a test —
 * bun killed the test first, so a slow enumeration could only ever surface as an
 * opaque 10008ms timeout instead of the `holder_enumeration_failed` WARN this
 * code exists to emit. Keep this strictly under that budget. (T-07604)
 */
const RENDERER_CONTROL_HOLDER_ENUMERATION_TIMEOUT_MS = 5_000

/**
 * `-b` is load-bearing, not tidiness. Without it lsof makes blocking `stat()`
 * calls on every mounted filesystem before it answers, including network
 * mounts. On max3 that includes a Time Machine **smbfs** share; when the NAS
 * is degraded the call blocks in an uninterruptible kernel call, and a process
 * stuck there cannot be killed until the call returns — so the AbortSignal
 * above CANNOT bound it. Observed 18339ms and 8397ms against the 5s budget,
 * plus 18 production occurrences on the recurring 300s sweep. (T-07740)
 *
 * `-w` suppresses the warning lsof prints about the mounts it skipped; that
 * warning is otherwise re-thrown as the error message and misattributes every
 * failure to the mount.
 *
 * `-b` is safe ONLY on this system-wide `-U` form: measured identical output
 * with and without it. It is INCOMPATIBLE with per-file arguments, because it
 * forbids the `stat()` lsof needs to resolve a path to a dev/inode —
 * `lsof -b -Fn -- <socket paths>` reports nothing held, silently, with exit 0.
 * Since unheld + past grace means delete, that variant would remove live
 * sockets. Do not narrow this call to specific paths while `-b` is present.
 */
export const LSOF_HELD_UNIX_SOCKET_ARGV: readonly string[] = ['lsof', '-b', '-w', '-U', '-Fn']
export const RENDERER_CONTROL_SOCKET_PREFIX = 'codex-app-server-renderer-control.'

/**
 * Reap stale Codex app renderer-control sockets under `<runtimeRoot>/btmux/`.
 * Holder discovery is a single `lsof` enumeration and never connects to the
 * socket. A candidate is removed only when it is both unheld and past grace.
 */
export async function sweepOrphanedRendererControlSockets(
  runtimeRoot: string,
  options: RendererControlSocketSweepOptions
): Promise<RendererControlSocketSweepResult> {
  const result: RendererControlSocketSweepResult = {
    scanned: 0,
    removed: 0,
    skippedHeld: 0,
    skippedWithinGrace: 0,
    errors: 0,
  }
  const dir = join(runtimeRoot, 'btmux')
  let entries: string[]
  try {
    entries = (await readdir(dir)).filter(isRendererControlSocketEntry)
  } catch {
    if (options.emitSummary !== false) writeRendererControlSweepSummary(result, options.graceMs)
    return result
  }
  result.scanned = entries.length
  if (entries.length === 0) {
    if (options.emitSummary !== false) writeRendererControlSweepSummary(result, options.graceMs)
    return result
  }

  let heldPaths: Set<string>
  const enumerate =
    options.enumerateHeldPaths ??
    (() => enumerateHeldUnixSocketPaths(options.holderEnumerationTimeoutMs))
  const enumerationStartedAt = performance.now()
  try {
    heldPaths = await enumerate()
    result.holderEnumerationMs = performance.now() - enumerationStartedAt
    result.holderEnumerationOutcome = 'ok'
  } catch (error) {
    result.holderEnumerationMs = performance.now() - enumerationStartedAt
    // Holder state is mandatory evidence for removal. If it cannot be collected,
    // preserve every candidate rather than falling back to age-only cleanup.
    result.errors = entries.length
    result.holderEnumerationOutcome =
      error instanceof HolderEnumerationAbortedError ? 'aborted' : 'failed'
    writeServerLog('WARN', 'broker.renderer_control_socket_holder_enumeration_failed', {
      // `outcome` is the field to read, NOT the message. On the aborted path the
      // message is whatever the killed process had already written to stderr,
      // which on macOS is a benign always-present mount warning that names an
      // innocent bystander and never mentions the abort. (T-07740)
      outcome: result.holderEnumerationOutcome,
      elapsedMs: result.holderEnumerationMs,
      error,
      scanned: result.scanned,
    })
    if (options.emitSummary !== false) writeRendererControlSweepSummary(result, options.graceMs)
    return result
  }

  const isHeld = await buildHeldMatcher(dir, entries, heldPaths)
  const now = Date.now()
  for (const entry of entries) {
    const socketPath = join(dir, entry)
    if (isHeld(entry)) {
      result.skippedHeld += 1
      continue
    }

    try {
      const stats = await stat(socketPath)
      const ageMs = now - stats.mtimeMs
      if (ageMs < options.graceMs) {
        result.skippedWithinGrace += 1
        continue
      }
      if (!stats.isSocket()) {
        result.errors += 1
        writeServerLog('WARN', 'broker.renderer_control_socket_invalid_entry', { socketPath })
        continue
      }

      await rm(socketPath, { force: true })
      result.removed += 1
      writeServerLog('INFO', 'broker.renderer_control_socket_removed', {
        socketPath,
        ageMs,
        graceMs: options.graceMs,
      })
    } catch (error) {
      result.errors += 1
      writeServerLog('WARN', 'broker.renderer_control_socket_sweep_failed', {
        socketPath,
        error,
      })
    }
  }

  if (options.emitSummary !== false) writeRendererControlSweepSummary(result, options.graceMs)
  return result
}

/**
 * Holder discovery outlived its budget and was killed. Distinct from a plain
 * failure because the stderr of a killed process describes whatever it had
 * already printed, not the kill — so the type is the only honest signal.
 */
export class HolderEnumerationAbortedError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`lsof holder enumeration exceeded ${timeoutMs}ms and was terminated`)
    this.name = 'HolderEnumerationAbortedError'
  }
}

async function enumerateHeldUnixSocketPaths(timeoutMs?: number): Promise<Set<string>> {
  const budgetMs = timeoutMs ?? RENDERER_CONTROL_HOLDER_ENUMERATION_TIMEOUT_MS
  const signal = AbortSignal.timeout(budgetMs)
  const proc = Bun.spawn([...LSOF_HELD_UNIX_SOCKET_ARGV], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  })

  /**
   * The deadline has to be raced, not merely armed.
   *
   * Killing the child does not end the read: the write end of these pipes is
   * held by EVERY process that inherited it, so anything the child spawned (or
   * orphaned) keeps stdout open and `Response.text()` pending long after the
   * kill. Awaiting the reads and the exit together therefore inherits the
   * lifetime of the slowest holder, which is exactly the unbounded wait this
   * budget exists to prevent — the same defect in a second disguise, and the
   * one that made a 250ms budget still take 5s in test. (T-07740)
   */
  const deadline = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new HolderEnumerationAbortedError(budgetMs)), {
      once: true,
    })
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
  // with stale stderr, and reporting that stderr as the cause is what sent an
  // earlier investigation after an innocent mount. (T-07740)
  if (signal.aborted) throw new HolderEnumerationAbortedError(budgetMs)
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `lsof exited with status ${exitCode}`)
  }

  return parseLsofUnixSocketPaths(stdout)
}

/**
 * Build a holder test that tolerates path-FORM differences.
 *
 * The held set carries the paths processes actually bound, which need not be
 * the string form this sweep composed from `runtimeRoot` — `/tmp` vs
 * `/private/tmp` on macOS is the obvious case, a symlinked runtime root the
 * general one. A miss means "not held", and "not held" past grace means DELETE,
 * so a string-equality miss is a live-socket deletion.
 *
 * Resolution goes through the PARENT DIRECTORY, never the socket: `realpath()`
 * on a Unix socket fails with EOPNOTSUPP on macOS, and a fail-safe built on it
 * marks every candidate held and silently disables the sweep. Directories
 * resolve fine, and the basename is exact by construction.
 *
 * Only held paths whose basename matches a candidate are resolved, so this
 * costs a couple of directory lookups rather than one per open socket.
 */
async function buildHeldMatcher(
  dir: string,
  entries: string[],
  heldPaths: Set<string>
): Promise<(entry: string) => boolean> {
  const wanted = new Set(entries)
  const normalized = new Set<string>()
  const resolvedDirs = new Map<string, string>()

  const resolveDir = async (path: string): Promise<string> => {
    const cached = resolvedDirs.get(path)
    if (cached !== undefined) return cached
    let resolved: string
    try {
      resolved = await realpath(path)
    } catch {
      resolved = path
    }
    resolvedDirs.set(path, resolved)
    return resolved
  }

  for (const held of heldPaths) {
    const base = basename(held)
    if (!wanted.has(base)) continue
    normalized.add(held)
    normalized.add(join(await resolveDir(dirname(held)), base))
  }

  const resolvedDir = await resolveDir(dir)
  return (entry: string) =>
    normalized.has(join(dir, entry)) || normalized.has(join(resolvedDir, entry))
}

export function parseLsofUnixSocketPaths(stdout: string): Set<string> {
  const heldPaths = new Set<string>()
  for (const line of stdout.split('\n')) {
    if (line.startsWith('n/')) {
      heldPaths.add(line.slice(1).replace(/ type=\w+$/, ''))
    }
  }
  return heldPaths
}

function writeRendererControlSweepSummary(
  result: RendererControlSocketSweepResult,
  graceMs: number
): void {
  writeServerLog('INFO', 'broker.renderer_control_socket_sweep_complete', {
    ...result,
    graceMs,
  })
}

function isRendererControlSocketEntry(entry: string): boolean {
  return entry.startsWith(RENDERER_CONTROL_SOCKET_PREFIX) && entry.endsWith('.sock')
}
