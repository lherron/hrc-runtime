import { readSync } from 'node:fs'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import type { AttachDescriptor } from 'hrc-sdk'

import { resolveRuntimeArg } from '../selector-resolve.js'
import { hasFlag, parseFlag, requireArg } from './argv.js'
import { isHrcDomainErrorLike } from './errors.js'
import type { ExecAttachDescriptor } from './scope.js'
import { createClient, fatal } from './shared.js'

export function isRuntimeUnavailableStatus(status: string): boolean {
  return status === 'terminated' || status === 'dead' || status === 'stale'
}

function runtimeRecency(runtime: HrcRuntimeSnapshot): number {
  const updatedAt = Date.parse(runtime.updatedAt)
  if (Number.isFinite(updatedAt)) {
    return updatedAt
  }

  const createdAt = Date.parse(runtime.createdAt)
  return Number.isFinite(createdAt) ? createdAt : 0
}

function sortRuntimesByRecency(runtimes: HrcRuntimeSnapshot[]): HrcRuntimeSnapshot[] {
  return [...runtimes].sort((left, right) => runtimeRecency(left) - runtimeRecency(right))
}

function hasContinuation(runtime: HrcRuntimeSnapshot): boolean {
  return runtime.continuation != null
}

export function selectLatestUsableRuntime(
  runtimes: HrcRuntimeSnapshot[]
): HrcRuntimeSnapshot | undefined {
  const usable = sortRuntimesByRecency(runtimes).filter(
    (runtime) => !isRuntimeUnavailableStatus(runtime.status)
  )
  const busyTmux = usable.filter(
    (runtime) => runtime.transport === 'tmux' && runtime.status === 'busy'
  )
  if (busyTmux.length > 0) {
    return busyTmux.at(-1)
  }

  const attachPreparedTmux = usable.filter(
    (runtime) =>
      runtime.transport === 'tmux' && runtime.harnessSessionJson?.['attachPrepared'] === true
  )
  if (attachPreparedTmux.length > 0) {
    return attachPreparedTmux.at(-1)
  }

  const headless = usable.filter((runtime) => runtime.transport === 'headless')
  if (headless.length > 0) {
    return headless.at(-1)
  }

  const resumable = usable.filter(hasContinuation)
  if (resumable.length > 0) {
    return resumable.at(-1)
  }

  return usable.at(-1)
}

function selectNextUsableRuntime(
  runtimes: HrcRuntimeSnapshot[],
  attemptedRuntimeIds: ReadonlySet<string>
): HrcRuntimeSnapshot | undefined {
  return selectLatestUsableRuntime(
    runtimes.filter((runtime) => !attemptedRuntimeIds.has(runtime.runtimeId))
  )
}

export async function attachOpenAiRuntime(
  client: HrcClient,
  hostSessionId: string,
  runtime: HrcRuntimeSnapshot
): Promise<ExecAttachDescriptor> {
  return attachWithRetry(client, hostSessionId, runtime)
}

export async function attachWithRetry(
  client: HrcClient,
  hostSessionId: string,
  runtime: HrcRuntimeSnapshot
): Promise<ExecAttachDescriptor> {
  const attemptedRuntimeIds = new Set<string>()
  let candidate: HrcRuntimeSnapshot | undefined = runtime

  while (candidate) {
    attemptedRuntimeIds.add(candidate.runtimeId)
    try {
      return await client.attachRuntime({ runtimeId: candidate.runtimeId })
    } catch (err) {
      if (!isHrcDomainErrorLike(err) || err.code !== HrcErrorCode.RUNTIME_UNAVAILABLE) {
        throw err
      }

      const refreshedRuntimes = await client.listRuntimes({ hostSessionId })
      candidate = selectNextUsableRuntime(refreshedRuntimes, attemptedRuntimeIds)
    }
  }

  throw new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'no attachable runtime available')
}

export async function bindGhosttySurfaceIfPresent(
  client: HrcClient,
  descriptor: AttachDescriptor
): Promise<void> {
  const ghosttySurfaceId = process.env['GHOSTTY_SURFACE_UUID']?.trim()
  if (!ghosttySurfaceId) {
    return
  }

  await client.bindSurface({
    surfaceKind: 'ghostty',
    ...descriptor.bindingFence,
    surfaceId: ghosttySurfaceId,
  })
}

export async function spawnAttachDescriptor(
  client: HrcClient,
  descriptor: AttachDescriptor
): Promise<ReturnType<typeof Bun.spawn>> {
  await bindGhosttySurfaceIfPresent(client, descriptor)
  return Bun.spawn(descriptor.argv, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
}

export async function waitForAttachProcess(
  attached: ReturnType<typeof Bun.spawn>,
  client?: HrcClient,
  hostSessionId?: string
): Promise<void> {
  const exitCode = await attached.exited
  if (exitCode === 0) {
    return
  }
  // A broker-tmux `/quit` reaps the lease by killing the lease tmux server out
  // from under the operator's `tmux attach-session`, which then exits non-zero
  // ("[server exited]"). That is the NORMAL end of an interactive run, not an
  // attach failure — so suppress the fatal when the run actually ended: if no
  // live runtime remains for this host session, the lease was reaped and the
  // operator was cleanly detached. Only a non-zero exit with a still-live
  // runtime (e.g. a genuinely broken attach descriptor) is a real failure.
  if (client !== undefined && hostSessionId !== undefined) {
    // The lease reap (killServer) and the reconcile that marks the runtime
    // terminated race against the operator's attach exiting; poll briefly so a
    // clean /quit is not misreported as a failure on the first probe.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const runtimes = await client.listRuntimes({ hostSessionId })
        const stillLive = runtimes.some((runtime) => !isRuntimeUnavailableStatus(runtime.status))
        if (!stillLive) {
          return
        }
      } catch {
        // Fall through to fatal on a status-probe failure — better a spurious
        // error than silently swallowing a real broken attach.
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  fatal(`attach command exited with code ${exitCode}`)
}

/** Format a millisecond span as `1h02m`, `4m12s`, or `9s`. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '—'
  }
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) {
    return `${h}h${String(m).padStart(2, '0')}m`
  }
  if (m > 0) {
    return `${m}m${String(s).padStart(2, '0')}s`
  }
  return `${s}s`
}

/** Local wall-clock `HH:MM:SS` for an ISO timestamp, or `—` when unparseable. */
function formatClock(iso: string | undefined): string {
  if (!iso) {
    return '—'
  }
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) {
    return '—'
  }
  return new Date(ms).toLocaleTimeString('en-GB', { hour12: false })
}

/**
 * Pure formatter for the broker-pushed session summary. Returns the rendered
 * report block (with surrounding blank lines, trailing newline) or null when no
 * summary payload is present. Shared by `hrc run`'s post-detach report and
 * `hrc session-report` (the headless-claude Ghostty viewer shutdown report,
 * T-01894) so the two surfaces never diverge.
 */
function formatSessionSummary(finalSummary: unknown, scopeLabel: string): string | null {
  const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`
  const payload = finalSummary as { summary?: Record<string, unknown>; reason?: string } | undefined
  const summary = payload?.summary
  if (!summary) {
    return null
  }
  const driver = typeof summary['driver'] === 'string' ? (summary['driver'] as string) : '—'
  const startedAt =
    typeof summary['startedAt'] === 'string' ? (summary['startedAt'] as string) : undefined
  const endedAt =
    typeof summary['lastActivityAt'] === 'string'
      ? (summary['lastActivityAt'] as string)
      : undefined
  const turns =
    typeof summary['turnsCompleted'] === 'number' ? (summary['turnsCompleted'] as number) : 0
  const reason = payload?.reason
  const exit = reason !== undefined ? `/quit (${reason})` : '/quit'
  const durationMs = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : Number.NaN

  const title = `─ session summary ─ ${scopeLabel} `
  const width = 64
  const topRule = '─'.repeat(Math.max(0, width - title.length))
  const lines = [
    '',
    dim(title) + dim(topRule),
    dim('  driver    ') + driver.padEnd(20) + dim('exit   ') + exit,
    dim('  duration  ') + formatDuration(durationMs).padEnd(20) + dim('turns  ') + String(turns),
    dim('  started   ') + formatClock(startedAt).padEnd(20) + dim('ended  ') + formatClock(endedAt),
    dim('─'.repeat(width)),
    '',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * After a clean `/quit` detach, render the broker-pushed session summary HRC
 * recorded at graceful exit. Best-effort: never throws and never blocks the
 * operator's return to their shell — if no summary was recorded (non-broker run,
 * hard kill, older broker) it prints nothing.
 */
export async function renderSessionSummary(
  client: HrcClient,
  runtimeId: string,
  scopeLabel: string
): Promise<void> {
  try {
    const inspect = await client.brokerInspect({ runtimeId })
    const block = formatSessionSummary(inspect.finalSummary, scopeLabel)
    if (block) {
      process.stdout.write(block)
    }
  } catch {
    // Best-effort: a probe failure must never disrupt the clean exit.
  }
}

/**
 * Block until a single keypress (best-effort). Sets raw mode for a true any-key
 * read when stdin is a TTY, then restores it. Never throws — a failure here must
 * not stop the surface from closing, nor hang it silently.
 */
function waitForKeypress(): void {
  const stdin = process.stdin
  let rawSet = false
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true)
      rawSet = true
    }
    const buf = Buffer.alloc(1)
    readSync(0, buf, 0, 1, null)
  } catch {
    // ignore — best-effort
  } finally {
    if (rawSet) {
      try {
        stdin.setRawMode(false)
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Render the broker-pushed session summary for a runtime, then (with --wait-key)
 * hold the surface open until the user presses a key. The headless-claude
 * Ghostty viewer window wraps its `tmux attach` with this so the operator sees
 * the same shutdown report `hrc run` prints (T-01894) before the window closes.
 *
 * Best-effort throughout: a fetch failure (or a missing summary) must STILL
 * reach the keypress gate, so the window never closes before the user reads it
 * and never hangs without explanation.
 */
export async function cmdSessionReport(args: string[]): Promise<void> {
  const runtimeArg = parseFlag(args, '--runtime') ?? requireArg(args, 0, '<runtimeId>')
  const scopeLabel = parseFlag(args, '--scope') ?? runtimeArg
  const waitKey = hasFlag(args, '--wait-key')

  let block: string | null = null
  try {
    const client = createClient()
    const runtimeId = await resolveRuntimeArg(runtimeArg, client)
    // The broker pushes invocation.summary BEFORE the lease reap, but the
    // viewer's `tmux attach` can exit a beat ahead of HRC recording
    // finalSummary — poll briefly so we don't miss it on the race.
    const attempts = 6
    for (let i = 0; i < attempts; i += 1) {
      const inspect = await client.brokerInspect({ runtimeId })
      block = formatSessionSummary(inspect.finalSummary, scopeLabel)
      if (block) break
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  } catch {
    // swallow — fall through to the keypress gate regardless
  }

  if (block) {
    process.stdout.write(block)
  } else {
    process.stdout.write(
      `\n\x1b[2m─ session ended ─ ${scopeLabel} (no summary recorded)\x1b[0m\n\n`
    )
  }

  if (waitKey) {
    process.stdout.write('\x1b[2mPress any key to close…\x1b[0m')
    waitForKeypress()
    process.stdout.write('\n')
  }
}

export function execAttachCommand(argv: string[], env?: Record<string, string> | undefined): void {
  const attached = Bun.spawnSync(argv, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })

  if (attached.exitCode !== 0) {
    fatal(`attach command exited with code ${attached.exitCode}`)
  }
}
