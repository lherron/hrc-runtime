import {
  HrcBadRequestError,
  HrcErrorCode,
  type HrcSessionRecord,
  HrcUnprocessableEntityError,
  validateSessionMetadataEntry,
} from 'hrc-core'
import { type HrcDatabase, canonicalLaneRef } from 'hrc-store-sqlite'
import { writeServerLog } from './server-log.js'
import { isRecord } from './server-parsers.js'
import { json } from './server-util.js'

export { SESSION_TITLE_MAX_LENGTH } from 'hrc-core'

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
  const force = value['force']
  const validated = validateSessionMetadataEntry('title', title)
  if (validated.reason)
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, validated.reason, {
      field: 'title',
    })
  return {
    title: validated.value as string,
    source: 'manual',
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
    return {
      ...session,
      laneRef: canonicalLaneRef(session.laneRef),
      ...(title === undefined ? {} : { title }),
    }
  })
}
