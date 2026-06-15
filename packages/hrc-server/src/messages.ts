import { formatSessionHandle } from 'agent-scope'
import { HrcBadRequestError, HrcErrorCode, normalizeSessionRef } from 'hrc-core'
import type {
  HrcMessageAddress,
  HrcMessageFilter,
  HrcMessageRecord,
  HrcRuntimeIntent,
} from 'hrc-core'
import { isRecord, parseSessionRef } from './server-parsers.js'

/**
 * Format an HrcMessageAddress for display in DM delivery (e.g. "clod@agent-spaces" or "human").
 */
export function formatDmAddress(addr: HrcMessageAddress): string {
  if (addr.kind === 'entity') return addr.entity
  try {
    const { scopeRef, laneRef } = parseSessionRef(normalizeSessionRef(addr.sessionRef))
    return formatSessionHandle({
      scopeRef,
      laneRef: laneRef === 'main' ? 'main' : `lane:${laneRef}`,
    })
  } catch {
    return addr.sessionRef
  }
}

/**
 * Format a DM body for literal tmux injection. Includes --reply-to so the
 * recipient's reply threads onto the originating request (required for
 * --wait on the sender side and for clean thread history).
 *
 *   [DM #<seq> <from> → <to>]: <content>
 *
 *     reply_cmd if reply requested:
 *     hrcchat dm <from> --reply-to <id> - <<'__HRC_REPLY__'
 *     <your reply>
 *     __HRC_REPLY__
 */
export function formatDmPayload(
  from: HrcMessageAddress,
  to: HrcMessageAddress,
  body: string,
  messageSeq: number,
  messageId: string
): string {
  const fromDisplay = formatDmAddress(from)
  const toDisplay = formatDmAddress(to)
  const maxChars = 1200
  let content = body
  if (content.length > maxChars) {
    const suffix = `… (truncated; hrcchat show ${messageSeq})`
    content = content.slice(0, maxChars - suffix.length) + suffix
  }
  const replyHint = [
    'reply_cmd if reply requested:',
    `hrcchat dm ${fromDisplay} --reply-to ${messageId} - <<'__HRC_REPLY__'`,
    '<your reply>',
    '__HRC_REPLY__',
  ].join('\n')
  return `[DM #${messageSeq} ${fromDisplay} → ${toDisplay}]: ${content}\n\n${replyHint}`
}

export function extractTextFromTurnMessagePayload(payload: unknown): string {
  if (!isRecord(payload)) return ''
  const message = payload['message']
  if (!isRecord(message)) return ''

  const content = message['content']
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (isRecord(part) && typeof part['text'] === 'string') return part['text']
      return ''
    })
    .join('')
}

export function normalizeTargetLane(laneRef: string | undefined): string | undefined {
  if (laneRef === undefined) {
    return undefined
  }

  return laneRef === 'default' ? 'main' : laneRef
}

export function targetLaneCandidates(laneRef: string): string[] {
  const normalized = normalizeTargetLane(laneRef) ?? laneRef
  return normalized === 'main' ? ['main', 'default'] : [normalized]
}

/**
 * Build a normalized session ref string (`<scopeRef>/lane:<lane>`) from a record's
 * scope/lane fields, applying the target lane normalization (default → main).
 */
export function formatSessionRef(scopeRef: string, laneRef: string): string {
  return `${scopeRef}/lane:${normalizeTargetLane(laneRef) ?? laneRef}`
}

export function normalizeTargetSessionRef(sessionRef: string): string {
  const normalized = normalizeSessionRef(sessionRef)
  const { scopeRef, laneRef } = parseSessionRef(normalized)
  return formatSessionRef(scopeRef, laneRef)
}

export function extractProjectId(scopeRef: string): string | undefined {
  const match = scopeRef.match(/:project:([^:]+)/)
  return match?.[1]
}

export function parseMessageAddress(input: unknown, field: string): HrcMessageAddress {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be an object`, {
      field,
    })
  }

  const kind = input['kind']
  if (kind === 'entity') {
    const entity = input['entity']
    if (entity !== 'human' && entity !== 'system') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `${field}.entity must be "human" or "system"`,
        { field: `${field}.entity` }
      )
    }
    return { kind: 'entity', entity }
  }

  if (kind === 'session') {
    const sessionRef = input['sessionRef']
    if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `${field}.sessionRef is required`,
        { field: `${field}.sessionRef` }
      )
    }
    return { kind: 'session', sessionRef: normalizeTargetSessionRef(sessionRef) }
  }

  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    `${field}.kind must be "session" or "entity"`,
    { field: `${field}.kind` }
  )
}

function parseMessageFilterList<T extends string>(
  input: unknown,
  field: string,
  allowed: readonly T[]
): T[] | undefined {
  if (input === undefined) {
    return undefined
  }
  if (!Array.isArray(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be an array`, {
      field,
    })
  }

  return input.map((entry, index) => {
    if (typeof entry !== 'string' || !allowed.includes(entry as T)) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `${field}[${index}] is invalid`,
        { field: `${field}[${index}]` }
      )
    }
    return entry as T
  })
}

function parseOptionalIntegerBodyField(input: unknown, field: string): number | undefined {
  if (input === undefined) {
    return undefined
  }
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field} must be a non-negative integer`,
      { field }
    )
  }
  return input
}

export function parseMessageFilter(input: unknown): HrcMessageFilter {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const thread = input['thread']
  if (thread !== undefined && (!isRecord(thread) || typeof thread['rootMessageId'] !== 'string')) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'thread.rootMessageId is required when thread is provided',
      { field: 'thread.rootMessageId' }
    )
  }

  const afterSeq = input['afterSeq']
  if (
    afterSeq !== undefined &&
    (typeof afterSeq !== 'number' || !Number.isInteger(afterSeq) || afterSeq < 0)
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'afterSeq must be a non-negative integer',
      { field: 'afterSeq' }
    )
  }

  const limit = input['limit']
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'limit must be a positive integer',
      { field: 'limit' }
    )
  }

  const order = input['order']
  if (order !== undefined && order !== 'asc' && order !== 'desc') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'order must be "asc" or "desc"', {
      field: 'order',
    })
  }

  const kinds = parseMessageFilterList(input['kinds'], 'kinds', [
    'dm',
    'literal',
    'system',
  ] as const)
  const phases = parseMessageFilterList(input['phases'], 'phases', [
    'request',
    'response',
    'oneway',
  ] as const)
  const hostSessionId = input['hostSessionId']
  if (hostSessionId !== undefined && typeof hostSessionId !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId must be a string', {
      field: 'hostSessionId',
    })
  }
  const generation = parseOptionalIntegerBodyField(input['generation'], 'generation')

  return {
    ...(input['participant'] !== undefined
      ? { participant: parseMessageAddress(input['participant'], 'participant') }
      : {}),
    ...(input['from'] !== undefined ? { from: parseMessageAddress(input['from'], 'from') } : {}),
    ...(input['to'] !== undefined ? { to: parseMessageAddress(input['to'], 'to') } : {}),
    ...(thread !== undefined
      ? { thread: { rootMessageId: thread['rootMessageId'] as string } }
      : {}),
    ...(hostSessionId !== undefined ? { hostSessionId } : {}),
    ...(generation !== undefined ? { generation } : {}),
    ...(afterSeq !== undefined ? { afterSeq } : {}),
    ...(kinds !== undefined ? { kinds } : {}),
    ...(phases !== undefined ? { phases } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(order !== undefined ? { order: order as 'asc' | 'desc' } : {}),
  }
}

export function parseSemanticDmRequest(input: unknown): {
  from: HrcMessageAddress
  to: HrcMessageAddress
  body: string
  mode?: 'auto' | 'headless' | 'nonInteractive' | undefined
  respondTo?: HrcMessageAddress | undefined
  replyToMessageId?: string | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  createIfMissing?: boolean | undefined
  parsedScopeJson?: Record<string, unknown> | undefined
  wait?: { enabled: boolean; timeoutMs?: number | undefined } | undefined
  allowStaleGeneration?: boolean | undefined
} {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  if (typeof input['body'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'body must be a string', {
      field: 'body',
    })
  }

  const mode = input['mode']
  if (mode !== undefined && mode !== 'auto' && mode !== 'headless' && mode !== 'nonInteractive') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'mode is invalid', {
      field: 'mode',
    })
  }

  const replyToMessageId = input['replyToMessageId']
  if (replyToMessageId !== undefined && typeof replyToMessageId !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'replyToMessageId must be a string',
      {
        field: 'replyToMessageId',
      }
    )
  }

  const respondTo =
    input['respondTo'] !== undefined
      ? parseMessageAddress(input['respondTo'], 'respondTo')
      : undefined

  const runtimeIntent = isRecord(input['runtimeIntent'])
    ? (input['runtimeIntent'] as HrcRuntimeIntent)
    : undefined

  const createIfMissing =
    typeof input['createIfMissing'] === 'boolean' ? input['createIfMissing'] : undefined

  const parsedScopeJson = isRecord(input['parsedScopeJson'])
    ? (input['parsedScopeJson'] as Record<string, unknown>)
    : undefined

  const waitInput = input['wait']
  const wait =
    isRecord(waitInput) && typeof waitInput['enabled'] === 'boolean'
      ? {
          enabled: waitInput['enabled'] as boolean,
          ...(typeof waitInput['timeoutMs'] === 'number'
            ? { timeoutMs: waitInput['timeoutMs'] as number }
            : {}),
        }
      : undefined

  const allowStaleGeneration =
    typeof input['allowStaleGeneration'] === 'boolean'
      ? (input['allowStaleGeneration'] as boolean)
      : undefined

  return {
    from: parseMessageAddress(input['from'], 'from'),
    to: parseMessageAddress(input['to'], 'to'),
    body: input['body'],
    ...(mode !== undefined ? { mode } : {}),
    ...(respondTo !== undefined ? { respondTo } : {}),
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    ...(runtimeIntent !== undefined ? { runtimeIntent } : {}),
    ...(createIfMissing !== undefined ? { createIfMissing } : {}),
    ...(parsedScopeJson !== undefined ? { parsedScopeJson } : {}),
    ...(wait !== undefined ? { wait } : {}),
    ...(allowStaleGeneration !== undefined ? { allowStaleGeneration } : {}),
  }
}

function addressMatches(a: HrcMessageAddress, b: HrcMessageAddress): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'entity' && b.kind === 'entity') return a.entity === b.entity
  if (a.kind === 'session' && b.kind === 'session') return a.sessionRef === b.sessionRef
  return false
}

export function matchesMessageFilter(record: HrcMessageRecord, filter: HrcMessageFilter): boolean {
  if (filter.afterSeq !== undefined && record.messageSeq <= filter.afterSeq) return false
  if (filter.from && !addressMatches(record.from, filter.from)) return false
  if (filter.to && !addressMatches(record.to, filter.to)) return false
  if (filter.participant) {
    if (
      !addressMatches(record.from, filter.participant) &&
      !addressMatches(record.to, filter.participant)
    ) {
      return false
    }
  }
  if (filter.thread && record.rootMessageId !== filter.thread.rootMessageId) return false
  if (
    filter.hostSessionId !== undefined &&
    record.execution.hostSessionId !== filter.hostSessionId
  ) {
    return false
  }
  if (filter.generation !== undefined && record.execution.generation !== filter.generation) {
    return false
  }
  if (filter.kinds && !filter.kinds.includes(record.kind)) return false
  if (filter.phases && !filter.phases.includes(record.phase)) return false
  return true
}
