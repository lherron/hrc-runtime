import { HrcErrorCode, type HrcSessionRecord, HrcUnprocessableEntityError } from 'hrc-core'
import { type HrcDatabase, canonicalLaneRef } from 'hrc-store-sqlite'
import { isRecord } from './server-parsers.js'

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
