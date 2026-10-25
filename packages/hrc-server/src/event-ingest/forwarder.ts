/**
 * Drives forwarding sweeps: the daemon's background forwarder, which sweeps until
 * the ledger is quiet and retries with capped exponential backoff, and the
 * one-shot drain of a dead runtime-local ledger.
 */

import { dirname } from 'node:path'

import { resolveIngestSocketPath } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import { forwardCursorPath } from './forward-cursors.js'
import type { ForwardCursors } from './forward-cursors.js'
import { forwardAvailableEvents } from './forward-sweep.js'
import type { EventForwardTarget } from './protocol.js'

const EVENT_FORWARD_MAX_RETRY_MS = 60_000

export type EventForwarder = {
  sourceRef: string
  target: EventForwardTarget
  cursorPath: string
  stop(): Promise<void>
}

export function eventForwardRetryDelayMs(
  consecutiveFailures: number,
  baseMs = 1_000,
  maxMs = EVENT_FORWARD_MAX_RETRY_MS
): number {
  const cap = Number.isFinite(maxMs) ? Math.max(1, Math.trunc(maxMs)) : 1
  const base = Number.isFinite(baseMs) ? Math.min(cap, Math.max(1, Math.trunc(baseMs))) : cap
  const failureCount = Number.isFinite(consecutiveFailures) ? Math.trunc(consecutiveFailures) : 1
  const exponent = Math.max(0, Math.min(30, failureCount - 1))
  return Math.min(cap, base * 2 ** exponent)
}

export function startEventForwarder(options: {
  db: HrcDatabase
  stateRoot: string
  sourceRef: string
  target: EventForwardTarget
  retryMs?: number
  maxRetryMs?: number
}): EventForwarder {
  const cursorPath = forwardCursorPath(options.stateRoot)
  const retryMs = Math.max(100, options.retryMs ?? 1_000)
  const maxRetryMs = Math.max(retryMs, options.maxRetryMs ?? EVENT_FORWARD_MAX_RETRY_MS)
  let stopping = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> = Promise.resolve()
  let consecutiveFailures = 0

  const run = async (): Promise<void> => {
    let nextDelayMs = retryMs
    while (!stopping) {
      try {
        const result = await forwardAvailableEvents({
          db: options.db,
          sourceRef: options.sourceRef,
          target: options.target,
          cursorPath,
        })
        consecutiveFailures = 0
        if (result.forwarded === 0 && result.deadLettered === 0) break
      } catch (error) {
        consecutiveFailures += 1
        nextDelayMs = eventForwardRetryDelayMs(consecutiveFailures, retryMs, maxRetryMs)
        writeServerLog('WARN', 'event_forwarder.retry', {
          sourceRef: options.sourceRef,
          target: options.target,
          consecutiveFailures,
          retryInMs: nextDelayMs,
          error,
        })
        break
      }
    }
    if (!stopping) timer = setTimeout(schedule, nextDelayMs)
  }
  const schedule = (): void => {
    running = run()
  }
  schedule()

  return {
    sourceRef: options.sourceRef,
    target: options.target,
    cursorPath,
    async stop() {
      stopping = true
      if (timer) clearTimeout(timer)
      await running
    },
  }
}

export async function drainEventDatabase(options: {
  dbPath: string
  sourceRef: string
  socketPath?: string
}): Promise<{ forwarded: number; cursors: ForwardCursors }> {
  // Daemon-side drain of a runtime-local event database it owns outright.
  const db = openHrcDatabase(options.dbPath, {
    migrate: true,
    logger: { info: (event, data) => writeServerLog('INFO', event, data) },
  })
  const cursorPath = forwardCursorPath(dirname(options.dbPath))
  let forwarded = 0
  try {
    while (true) {
      const result = await forwardAvailableEvents({
        db,
        sourceRef: options.sourceRef,
        target: {
          kind: 'unix',
          socketPath: options.socketPath ?? resolveIngestSocketPath(),
        },
        cursorPath,
      })
      forwarded += result.forwarded
      if (result.forwarded === 0 && result.deadLettered === 0) {
        return { forwarded, cursors: result.cursors }
      }
    }
  } finally {
    db.close()
  }
}
