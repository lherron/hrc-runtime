import { randomUUID } from 'node:crypto'

import { HrcBadRequestError, HrcErrorCode, HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  CreateMessageResponse,
  EnsureTargetResponse,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  RestartStyle,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {
  isMatchingInteractiveTmuxBrokerRuntime,
  validateEnsureRuntimeIntent,
} from './broker-decisions.js'
import { parseOptionalBirthCredential } from './federation/birth-credential.js'
import {
  persistSessionTaskClaimAuthority,
  withSummonAuthority,
} from './federation/summon-gate-server.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'

import { normalizeTargetSessionRef, parseMessageAddress } from './messages.js'
import { requireSession } from './require-helpers.js'
import { findLatestRuntime } from './runtime-select.js'
import { handleSdkDispatchTurn } from './selector-message-handlers/sdk-dispatch.js'
import {
  handleBrokerLiteralInputBySelector,
  handleCaptureBySelector,
  handleDispatchTurnBySelector,
  handleLiteralInputBySelector,
} from './selector-message-handlers/selector-input.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { mapSessionRow } from './server-misc.js'
import { isRecord, parseJsonBody, parseSessionRef } from './server-parsers.js'
import type { SessionRow } from './server-types.js'
import { createHostSessionId, isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { SESSION_HAS_RUNNING_RUNTIME_SQL, SESSION_RECENCY_SQL } from './session-recency.js'
import { createSessionSuccessorFromContinuation } from './session-successor.js'
import { findTargetSession, toTargetView } from './target-view.js'

export { handleSdkDispatchTurn } from './selector-message-handlers/sdk-dispatch.js'
export {
  handleBrokerLiteralInputBySelector,
  handleCaptureBySelector,
  handleDispatchTurnBySelector,
  handleLiteralInputBySelector,
} from './selector-message-handlers/selector-input.js'

export function listSessionsByScope(
  this: HrcServerInstanceForHandlers,
  scopeRef: string,
  laneRef?: string
): HrcSessionRecord[] {
  if (laneRef) {
    return this.db.sessions.listByScopeRef(scopeRef, laneRef)
  }

  return this.db.sessions.listByScopeRef(scopeRef)
}

export function listAllSessions(
  this: HrcServerInstanceForHandlers,
  laneRef?: string
): HrcSessionRecord[] {
  const sql = laneRef
    ? `
        SELECT
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          status,
          prior_host_session_id,
          created_at,
          updated_at,
          parsed_scope_json,
          ancestor_scope_refs_json,
          last_applied_intent_json,
          continuation_json
        FROM sessions
        WHERE lane_ref = ?
        ORDER BY scope_ref ASC, generation ASC
      `
    : `
        SELECT
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          status,
          prior_host_session_id,
          created_at,
          updated_at,
          parsed_scope_json,
          ancestor_scope_refs_json,
          last_applied_intent_json,
          continuation_json
        FROM sessions
        ORDER BY scope_ref ASC, lane_ref ASC, generation ASC
      `

  const rows = laneRef
    ? this.db.sqlite.query<SessionRow, [string]>(sql).all(laneRef)
    : this.db.sqlite.query<SessionRow, []>(sql).all()

  return rows.map(mapSessionRow)
}

/**
 * T-07575 — the bounded default projection behind an unscoped
 * `GET /v1/sessions`.
 *
 * `listAllSessions` above stays deliberately unbounded: it is the internal
 * primitive that the retention sweep and every whole-store consumer needs. The
 * bound belongs at the HTTP boundary, where a caller who asked a question with
 * no limits in it gets a useful answer instead of the entire history of the
 * host.
 *
 * "Recent" is a union, not an intersection: a session qualifies if its
 * authoritative recency (`SESSION_RECENCY_SQL` — see that module for why
 * `sessions.updated_at` is *not* it) is at or after `activeSince`, OR if it
 * currently holds a non-terminal runtime. The second arm exists because a
 * session that is still running must never fall out of the default view — being
 * live is itself the strongest possible reason to be listed, and that includes
 * a turn parked on an operator prompt, which has no activity but is not idle.
 */
export function listRecentSessions(
  this: HrcServerInstanceForHandlers,
  activeSince: string,
  laneRef?: string
): HrcSessionRecord[] {
  const sql = `
        SELECT
          s.host_session_id,
          s.scope_ref,
          s.lane_ref,
          s.generation,
          s.status,
          s.prior_host_session_id,
          s.created_at,
          s.updated_at,
          s.parsed_scope_json,
          s.ancestor_scope_refs_json,
          s.last_applied_intent_json,
          s.continuation_json
        FROM sessions s
        WHERE (${SESSION_RECENCY_SQL} >= ? OR ${SESSION_HAS_RUNNING_RUNTIME_SQL})
        ${laneRef ? 'AND s.lane_ref = ?' : ''}
        ORDER BY s.scope_ref ASC, s.lane_ref ASC, s.generation ASC
      `

  const rows = laneRef
    ? this.db.sqlite.query<SessionRow, [string, string]>(sql).all(activeSince, laneRef)
    : this.db.sqlite.query<SessionRow, [string]>(sql).all(activeSince)

  return rows.map(mapSessionRow)
}

/**
 * T-07575 — host session ids whose authoritative recency has fallen behind
 * `activeSince` and which hold no live runtime.
 *
 * The archive sweep asks SQL for its candidates rather than filtering
 * `listAllSessions` in JS so that the projection and the sweep cannot drift
 * apart: both read the same recency expression from the same module. The
 * remaining conditions the sweep applies (primary scope, continuation key) are
 * policy, not recency, and stay in the caller where they are legible.
 */
export function listIdleSessionCandidates(
  this: HrcServerInstanceForHandlers,
  activeSince: string
): Set<string> {
  const rows = this.db.sqlite
    .query<{ host_session_id: string }, [string]>(
      `
        SELECT s.host_session_id
        FROM sessions s
        WHERE s.status = 'active'
          AND ${SESSION_RECENCY_SQL} < ?
          AND NOT ${SESSION_HAS_RUNNING_RUNTIME_SQL}
      `
    )
    .all(activeSince)

  return new Set(rows.map((row) => row.host_session_id))
}

export async function ensureRuntimeForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  restartStyle: RestartStyle
): Promise<HrcRuntimeSnapshot> {
  assertLocalPersonaAllowed(this, session.scopeRef)
  validateEnsureRuntimeIntent(intent)
  this.db.sessions.updateIntent(session.hostSessionId, intent, timestamp())
  const brokerOptions = this.selectInteractiveTmuxBrokerOptions(intent)
  if (!brokerOptions) {
    throw new HrcRuntimeUnavailableError('ensureRuntime supports only broker-admissible runtimes', {
      hostSessionId: session.hostSessionId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
      route: 'interactive-broker',
    })
  }

  const existingBrokerRuntime = findLatestRuntime(this.db, session.hostSessionId)
  if (
    restartStyle === 'reuse_pty' &&
    existingBrokerRuntime &&
    !isRuntimeUnavailableStatus(existingBrokerRuntime.status) &&
    isMatchingInteractiveTmuxBrokerRuntime(
      existingBrokerRuntime,
      intent,
      brokerOptions.allowedBrokerDriver
    )
  ) {
    return existingBrokerRuntime
  }

  if (existingBrokerRuntime && !isRuntimeUnavailableStatus(existingBrokerRuntime.status)) {
    this.markRuntimeStaleForBrokerReprovision(session, existingBrokerRuntime, {
      reason: 'ensure-runtime-broker-reprovision',
      allowedBrokerDriver: brokerOptions.allowedBrokerDriver,
    })
  }

  return await this.startInteractiveTmuxBrokerRuntime(
    session,
    intent,
    `run-${randomUUID()}`,
    brokerOptions
  )
}

export async function ensureTargetSession(
  this: HrcServerInstanceForHandlers,
  sessionRef: string,
  intent: HrcRuntimeIntent,
  parsedScopeJson?: Record<string, unknown>,
  birthCredential?: string,
  origin: 'local' | 'federated-ingress' = 'local'
): Promise<HrcSessionRecord> {
  const normalized = normalizeTargetSessionRef(sessionRef)
  const { scopeRef, laneRef } = parseSessionRef(normalized)
  assertLocalPersonaAllowed(this, scopeRef)
  const existing = findTargetSession(this.db, normalized)
  if (existing) {
    const now = timestamp()
    if (existing.status === 'archived' && existing.continuation?.key) {
      // Successor creation from an archived continuation is a summon: "no live
      // runtime" is not settlement of authority (spec §5).
      return await withSummonAuthority(
        this,
        {
          scopeRef,
          laneRef,
          path: 'archived-successor',
          intent: 'implicit',
          knownSession: true,
          origin,
          capabilityHint: { placement: intent.placement, harness: intent.harness },
          // T-07398: a successor is a birth, so its directive block still
          // decides placement (gap-filling only) and provisioning.
          ...(intent.provision === undefined ? {} : { provision: intent.provision }),
          ...(birthCredential === undefined ? {} : { birthCredential }),
        },
        (claimAuthority) => {
          const raced = findTargetSession(this.db, normalized)
          if (raced !== null && raced.hostSessionId !== existing.hostSessionId) return raced
          const successor = this.db.sqlite.transaction(() => {
            const created = createSessionSuccessorFromContinuation(this.db, existing, {
              lastAppliedIntentJson: intent,
              ...(parsedScopeJson ? { parsedScopeJson } : {}),
            })
            if (claimAuthority !== undefined) {
              persistSessionTaskClaimAuthority(
                this,
                created.hostSessionId,
                claimAuthority,
                created.createdAt
              )
            } else {
              this.db.sessionTaskClaimAuthorities.copy(
                existing.hostSessionId,
                created.hostSessionId,
                created.createdAt
              )
            }
            return created
          })()
          this.notifyEvent(
            this.appendEvent(successor, 'session.created', {
              created: true,
              summon: true,
              priorHostSessionId: existing.hostSessionId,
              reason: 'successor-from-continuation',
            })
          )
          return successor
        }
      )
    }
    this.db.sessions.updateIntent(existing.hostSessionId, intent, now)
    if (parsedScopeJson) {
      this.db.sessions.updateParsedScope(existing.hostSessionId, parsedScopeJson, now)
    }
    // Re-read to return the updated record
    return requireSession(this.db, existing.hostSessionId)
  }

  return await withSummonAuthority(
    this,
    {
      scopeRef,
      laneRef,
      path: 'ensure-target',
      intent: 'implicit',
      origin,
      capabilityHint: { placement: intent.placement, harness: intent.harness },
      // T-07398: the dm/ensure door is the second provisioning door, and it
      // honors the same directive block on the same terms as the claim doors.
      ...(intent.provision === undefined ? {} : { provision: intent.provision }),
      ...(birthCredential === undefined ? {} : { birthCredential }),
    },
    (claimAuthority) => {
      const raced = findTargetSession(this.db, normalized)
      if (raced !== null) return raced
      const now = timestamp()
      const hostSessionId = createHostSessionId()
      const session: HrcSessionRecord = {
        hostSessionId,
        scopeRef,
        laneRef,
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
        lastAppliedIntentJson: intent,
        ...(parsedScopeJson ? { parsedScopeJson } : {}),
      }

      const created = this.db.sqlite.transaction(() => {
        const inserted = this.db.sessions.insert(session)
        if (claimAuthority !== undefined) {
          persistSessionTaskClaimAuthority(this, hostSessionId, claimAuthority, now)
        }
        this.db.continuities.upsert({
          scopeRef,
          laneRef,
          activeHostSessionId: hostSessionId,
          updatedAt: now,
        })
        return inserted
      })()

      const event = this.appendEvent(created, 'session.created', { created: true, summon: true })
      this.notifyEvent(event)
      return created
    }
  )
}

export async function handleEnsureTarget(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const sessionRef = body['sessionRef']
  if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required', {
      field: 'sessionRef',
    })
  }

  const runtimeIntent = body['runtimeIntent']
  if (!isRecord(runtimeIntent)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeIntent is required', {
      field: 'runtimeIntent',
    })
  }

  const parsedScopeJson = isRecord(body['parsedScopeJson'])
    ? (body['parsedScopeJson'] as Record<string, unknown>)
    : undefined
  const birthCredential = parseOptionalBirthCredential(body['birthCredential'])

  const session = await this.ensureTargetSession(
    sessionRef,
    runtimeIntent as HrcRuntimeIntent,
    parsedScopeJson,
    birthCredential
  )
  return json(toTargetView(this.db, session) satisfies EnsureTargetResponse)
}

/**
 * `POST /v1/messages` — direct write to the `messages` table.
 *
 * T-07612 flag day (T-07616): like `/v1/messages/dm`, this keeps working while
 * having no caller left in the collective. Fencing an unreachable route buys
 * nothing observable and would strand the `hrc show` message-selector reads
 * that use it to seed. The writers that actually carried collaboration —
 * hrcmail and the federation accept path — are deleted outright. This route,
 * the DM route, and the table retire together in wave 5 (T-07617).
 */
export async function handleCreateMessage(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  if (typeof body['body'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'body must be a string', {
      field: 'body',
    })
  }

  const kind = body['kind']
  if (kind !== 'dm' && kind !== 'literal' && kind !== 'system') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'kind must be dm, literal, or system',
      {
        field: 'kind',
      }
    )
  }

  const phase = body['phase']
  if (phase !== 'request' && phase !== 'response' && phase !== 'oneway') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'phase must be request, response, or oneway',
      {
        field: 'phase',
      }
    )
  }

  const from = parseMessageAddress(body['from'], 'from')
  const to = parseMessageAddress(body['to'], 'to')

  const replyToMessageId = body['replyToMessageId']
  if (replyToMessageId !== undefined && typeof replyToMessageId !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'replyToMessageId must be a string',
      {
        field: 'replyToMessageId',
      }
    )
  }

  let rootMessageId: string | undefined
  if (replyToMessageId !== undefined) {
    const parent = this.db.messages.getById(replyToMessageId)
    if (!parent) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `unknown replyToMessageId "${replyToMessageId}"`,
        {
          field: 'replyToMessageId',
        }
      )
    }
    rootMessageId = parent.rootMessageId
  }

  const execution = isRecord(body['execution'])
    ? (body['execution'] as Partial<{ state: string }>)
    : undefined
  const metadataJson = isRecord(body['metadataJson'])
    ? (body['metadataJson'] as Record<string, unknown>)
    : undefined

  const record = this.insertAndNotifyMessage({
    messageId: `msg-${randomUUID()}`,
    kind,
    phase,
    from,
    to,
    body: body['body'],
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    ...(rootMessageId !== undefined ? { rootMessageId } : {}),
    ...(execution
      ? { execution: execution as Parameters<HrcDatabase['messages']['insert']>[0]['execution'] }
      : {}),
    ...(metadataJson ? { metadataJson } : {}),
  })

  return json(record satisfies CreateMessageResponse)
}

export const selectorMessageHandlersMethods = {
  listSessionsByScope,
  listAllSessions,
  listRecentSessions,
  listIdleSessionCandidates,
  ensureRuntimeForSession,
  handleSdkDispatchTurn,
  ensureTargetSession,
  handleEnsureTarget,
  handleCreateMessage,
  handleCaptureBySelector,
  handleLiteralInputBySelector,
  handleBrokerLiteralInputBySelector,
  handleDispatchTurnBySelector,
}

export type SelectorMessageHandlersMethods = typeof selectorMessageHandlersMethods
