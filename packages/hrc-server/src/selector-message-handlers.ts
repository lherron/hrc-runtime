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
import { normalizeTargetSessionRef, parseMessageAddress } from './messages.js'
import { requireSession } from './require-helpers.js'
import { findLatestRuntime } from './runtime-select.js'
import {
  handleSdkDispatchTurn,
  recordDetachedSemanticTurnFailure,
} from './selector-message-handlers/sdk-dispatch.js'
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
import { findTargetSession, toTargetView } from './target-view.js'

export {
  handleSdkDispatchTurn,
  recordDetachedSemanticTurnFailure,
} from './selector-message-handlers/sdk-dispatch.js'
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

export async function ensureRuntimeForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  restartStyle: RestartStyle
): Promise<HrcRuntimeSnapshot> {
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

export function ensureTargetSession(
  this: HrcServerInstanceForHandlers,
  sessionRef: string,
  intent: HrcRuntimeIntent,
  parsedScopeJson?: Record<string, unknown>
): HrcSessionRecord {
  const normalized = normalizeTargetSessionRef(sessionRef)
  const existing = findTargetSession(this.db, normalized)
  if (existing) {
    const now = timestamp()
    this.db.sessions.updateIntent(existing.hostSessionId, intent, now)
    if (parsedScopeJson) {
      this.db.sessions.updateParsedScope(existing.hostSessionId, parsedScopeJson, now)
    }
    // Re-read to return the updated record
    return requireSession(this.db, existing.hostSessionId)
  }

  const { scopeRef, laneRef } = parseSessionRef(normalized)
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

  const created = this.db.sessions.insert(session)
  this.db.continuities.upsert({
    scopeRef,
    laneRef,
    activeHostSessionId: hostSessionId,
    updatedAt: now,
  })

  const event = this.appendEvent(created, 'session.created', { created: true, summon: true })
  this.notifyEvent(event)
  return created
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

  const session = this.ensureTargetSession(
    sessionRef,
    runtimeIntent as HrcRuntimeIntent,
    parsedScopeJson
  )
  return json(toTargetView(this.db, session) satisfies EnsureTargetResponse)
}

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
  ensureRuntimeForSession,
  handleSdkDispatchTurn,
  recordDetachedSemanticTurnFailure,
  ensureTargetSession,
  handleEnsureTarget,
  handleCreateMessage,
  handleCaptureBySelector,
  handleLiteralInputBySelector,
  handleBrokerLiteralInputBySelector,
  handleDispatchTurnBySelector,
}

export type SelectorMessageHandlersMethods = typeof selectorMessageHandlersMethods
