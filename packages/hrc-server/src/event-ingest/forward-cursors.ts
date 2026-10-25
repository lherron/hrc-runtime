/**
 * The forwarder's durable state: one cursor file (format version 1) beside the
 * ledger it reads, holding a cursor per feed and the dead letters that let a
 * cursor pass a row the receiver will never accept (T-07197).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeServerLog } from '../server-log.js'
import type { IngestFeed } from './protocol.js'

const CURSOR_FILE = 'event-forward-cursors.json'

export type ForwardCursorKey = 'toolResultBlobs' | 'hrcEvents' | 'brokerInvocationEvents'
export type ForwardDeadLetterCode = 'invalid_batch' | 'divergent_duplicate' | 'oversized_event'

type ForwardDeadLetter = {
  sourceRef: string
  feed: IngestFeed
  cursor: number
  code: ForwardDeadLetterCode
  message: string
  deadLetteredAt: string
}

export type ForwardCursors = {
  version: 1
  toolResultBlobs: number
  hrcEvents: number
  brokerInvocationEvents: number
  deadLetters: ForwardDeadLetter[]
}

export function forwardCursorPath(directory: string): string {
  return join(directory, CURSOR_FILE)
}

function initialCursors(): ForwardCursors {
  return {
    version: 1,
    toolResultBlobs: 0,
    hrcEvents: 0,
    brokerInvocationEvents: 0,
    deadLetters: [],
  }
}

export async function readCursors(path: string): Promise<ForwardCursors> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ForwardCursors>
    if (
      parsed.version === 1 &&
      Number.isSafeInteger(parsed.hrcEvents) &&
      Number.isSafeInteger(parsed.brokerInvocationEvents)
    ) {
      return {
        version: 1,
        toolResultBlobs: Number.isSafeInteger(parsed.toolResultBlobs)
          ? (parsed.toolResultBlobs as number)
          : 0,
        hrcEvents: parsed.hrcEvents as number,
        brokerInvocationEvents: parsed.brokerInvocationEvents as number,
        deadLetters: Array.isArray(parsed.deadLetters) ? parsed.deadLetters : [],
      }
    }
  } catch {
    // Missing or invalid cursor state starts at the ledger beginning.
  }
  return initialCursors()
}

export async function writeCursors(path: string, cursors: ForwardCursors): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(cursors)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

export async function deadLetterAndAdvance(options: {
  cursorPath: string
  cursors: ForwardCursors
  cursorKey: ForwardCursorKey
  sourceRef: string
  feed: IngestFeed
  cursor: number
  code: ForwardDeadLetterCode
  message: string
}): Promise<void> {
  options.cursors[options.cursorKey] = Math.max(options.cursors[options.cursorKey], options.cursor)
  if (
    !options.cursors.deadLetters.some(
      (letter) => letter.feed === options.feed && letter.cursor === options.cursor
    )
  ) {
    options.cursors.deadLetters.push({
      sourceRef: options.sourceRef,
      feed: options.feed,
      cursor: options.cursor,
      code: options.code,
      message: options.message,
      deadLetteredAt: new Date().toISOString(),
    })
  }
  await writeCursors(options.cursorPath, options.cursors)
  writeServerLog('WARN', 'event_forwarder.dead_letter', {
    sourceRef: options.sourceRef,
    feed: options.feed,
    cursor: options.cursor,
    code: options.code,
    message: options.message,
  })
}
