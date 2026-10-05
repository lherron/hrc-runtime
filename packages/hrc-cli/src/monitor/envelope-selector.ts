import { CliUsageError } from 'cli-kit'
import { runBoundedSubprocess } from 'hrc-core'

/**
 * `hrc monitor watch EN-xxxxx` — turn progress for a presented envelope
 * (T-07612 §7).
 *
 * An envelope id is a wrkq row id, and wrkq has no idea what a run is. The
 * join is the presentation receipt HRC itself wrote: `presented_to` carries the
 * `runtimeId` and `runId` of the turn the envelope was injected into, so the
 * selector resolves to the LATEST receipt and the watch proceeds as an ordinary
 * runtime watch.
 *
 * This is deliberately distinct from `wrkq monitor watch EN-xxxxx`, which
 * follows the LEDGER — created, presented, acked. One selector, two questions:
 * "what is the turn doing" is HRC's, "what happened to the obligation" is
 * wrkq's.
 */

const ENVELOPE_ID_PATTERN = /^EN-\d+$/

export function isEnvelopeSelector(raw: string): boolean {
  return ENVELOPE_ID_PATTERN.test(raw.trim())
}

type Presentation = {
  runtimeId?: unknown
  runId?: unknown
  presentedAt?: unknown
}

/**
 * Resolve every `EN-xxxxx` in a selector list to the runtime that was presented
 * it. Non-envelope selectors pass through untouched.
 */
export async function resolveEnvelopeSelectors(
  rawSelectors: readonly string[],
  lookup: (envelopeId: string) => Promise<unknown> = wrkqEnvelopeShow(ENVELOPE_SHOW_TIMEOUT_MS)
): Promise<string[]> {
  const resolved: string[] = []
  for (const raw of rawSelectors) {
    if (!isEnvelopeSelector(raw)) {
      resolved.push(raw)
      continue
    }
    const envelopeId = raw.trim()
    resolved.push(await resolveOne(envelopeId, lookup))
  }
  return resolved
}

async function resolveOne(
  envelopeId: string,
  lookup: (envelopeId: string) => Promise<unknown>
): Promise<string> {
  let envelope: unknown
  try {
    envelope = await lookup(envelopeId)
  } catch (error) {
    throw new CliUsageError(
      `could not resolve ${envelopeId} against the wrkq ledger: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  const receipts = presentationsOf(envelope)
  if (receipts.length === 0) {
    throw new CliUsageError(
      `${envelopeId} has not been presented yet, so it has no turn to watch. Its ledger state is \`wrkc show ${envelopeId}\`.`
    )
  }
  const newest = receipts[receipts.length - 1] as Presentation
  if (typeof newest.runtimeId === 'string' && newest.runtimeId.length > 0) {
    return `runtime:${newest.runtimeId}`
  }
  if (typeof newest.runId === 'string' && newest.runId.length > 0) {
    return `run:${newest.runId}`
  }
  throw new CliUsageError(
    `${envelopeId} was presented, but its receipt names no runtime or run to watch.`
  )
}

function presentationsOf(envelope: unknown): Presentation[] {
  if (typeof envelope !== 'object' || envelope === null) return []
  const presented = (envelope as { presentedTo?: unknown }).presentedTo
  if (!Array.isArray(presented)) return []
  return presented
    .filter((entry): entry is Presentation => typeof entry === 'object' && entry !== null)
    .sort((left, right) =>
      String(left.presentedAt ?? '').localeCompare(String(right.presentedAt ?? ''))
    )
}

/** A wedged or unreachable ledger fails the resolve instead of hanging it (T-10244). */
export const ENVELOPE_SHOW_TIMEOUT_MS = 10_000

/**
 * One-shot `wrkq rpc --stdio` read.
 *
 * The CLI is short-lived and resolves at most a handful of ids, so it spawns
 * per invocation rather than holding the daemon's long-lived transport.
 */
export function wrkqEnvelopeShow(
  timeoutMs: number,
  env?: Record<string, string | undefined>
): (envelopeId: string) => Promise<unknown> {
  return async (envelopeId) => {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'wrkq.envelope.show',
      params: { envelope: envelopeId, principalRef: 'agent:hrc' },
    })
    const { stdout, stderr } = await runBoundedSubprocess(['wrkq', 'rpc', '--stdio'], {
      timeoutMs,
      env,
      stdin: `${request}\n`,
      processGroup: true,
    })
    const line = stdout.split('\n').find((candidate) => candidate.trim().length > 0)
    if (line === undefined) {
      throw new Error(stderr.trim() || 'wrkq returned no response')
    }
    const frame = JSON.parse(line) as { result?: unknown; error?: { message?: string } }
    if (frame.error !== undefined) {
      throw new Error(frame.error.message ?? 'wrkq rejected the request')
    }
    return frame.result
  }
}
