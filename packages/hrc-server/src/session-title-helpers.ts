import {
  HrcBadRequestError,
  HrcErrorCode,
  type HrcSessionRecord,
  HrcUnprocessableEntityError,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { writeServerLog } from './server-log.js'
import { isRecord } from './server-parsers.js'
import { json } from './server-util.js'

export const SESSION_TITLE_MAX_LENGTH = 200

/** The selector is admitted only by the six rev11 execution-creating doors. */
export const FORMAT2_CAPABLE_INGRESS_PATHS = new Set([
  '/v1/broker-sessions/open',
  '/v1/turns',
  '/v1/submissions/steer',
  '/v1/submissions/enqueue',
  '/v1/submissions/invoke',
  '/v1/submissions/preempt',
])

/**
 * A selector at any other POST route is a request-contract refusal before its
 * route parser can resolve a target, allocate identity, or create a runtime.
 * Use a clone so the selected handler retains its ordinary body stream.
 */
export async function refuseExecutionFormatAtSealedDoor(
  request: Request,
  pathname: string
): Promise<void> {
  if (request.method !== 'POST' || FORMAT2_CAPABLE_INGRESS_PATHS.has(pathname)) return
  const body = await request
    .clone()
    .json()
    .catch(() => undefined)
  if (!isRecord(body) || !Object.hasOwn(body, 'executionFormat')) return
  throw new HrcUnprocessableEntityError(
    HrcErrorCode.EXECUTION_FORMAT_UNSUPPORTED_DOOR,
    `executionFormat is unsupported at ${pathname}`,
    { field: 'executionFormat', path: pathname }
  )
}

/**
 * C0 controls and DEL. A newline breaks the roster row structure and a raw CSI
 * sequence is echoed to the operator's terminal verbatim. Checked by code point
 * rather than by regex so the source file stays free of control bytes itself.
 */
export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export type SessionTitleWriteInput = {
  title: string
  source: 'generated' | 'manual'
  model?: string | undefined
  force: boolean
}

export function parseSessionTitleWriteInput(value: unknown): SessionTitleWriteInput {
  if (!isRecord(value)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const title = value['title']
  const source = value['source']
  const model = value['model']
  const force = value['force']
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'title is required', {
      field: 'title',
    })
  }
  // Titles are rendered unescaped into a terminal and are destined to be
  // model-generated, so the write boundary is the only place to bound them.
  const normalizedTitle = title.trim()
  if (normalizedTitle.length > SESSION_TITLE_MAX_LENGTH) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `title must be at most ${SESSION_TITLE_MAX_LENGTH} characters`,
      { field: 'title', maxLength: SESSION_TITLE_MAX_LENGTH, length: normalizedTitle.length }
    )
  }
  if (hasControlCharacters(normalizedTitle)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'title must not contain control characters',
      { field: 'title' }
    )
  }
  if (source !== 'generated' && source !== 'manual') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'source must be generated or manual',
      { field: 'source' }
    )
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'model must be a string', {
      field: 'model',
    })
  }
  if (force !== undefined && typeof force !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'force must be a boolean', {
      field: 'force',
    })
  }
  return {
    title: normalizedTitle,
    source,
    ...(model === undefined ? {} : { model }),
    force: force === true,
  }
}

/**
 * T-08566 stage 1: the launch-wrapper hook, OTEL and launch-callback ingest is
 * retired. No production component composes these requests, and the hook route
 * could terminalize a broker run from an unauthenticated native payload.
 * Refuse with a named 410 and write nothing durable.
 */
export function legacyLaunchIngestRetired(route: string): Response {
  writeServerLog('WARN', 'server.legacy_launch_ingest_refused', { route })
  return json({ error: { code: 'legacy_launch_ingest_retired', route } }, 410)
}

export function decodeSessionTitleHostSessionId(encodedHostSessionId: string): string {
  try {
    const hostSessionId = decodeURIComponent(encodedHostSessionId)
    if (hostSessionId.length > 0) return hostSessionId
  } catch {}
  throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'host session id is malformed', {
    field: 'hostSessionId',
  })
}

export function decorateSessionTitles(
  db: HrcDatabase,
  sessions: HrcSessionRecord[]
): HrcSessionRecord[] {
  const titles = new Map(
    db.sessionTitles.listAll().map((record) => [record.hostSessionId, record.title] as const)
  )
  return sessions.map((session) => {
    const title = titles.get(session.hostSessionId)
    return title === undefined ? session : { ...session, title }
  })
}
