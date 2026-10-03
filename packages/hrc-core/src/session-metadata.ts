import type { parseScopeRef } from 'agent-scope'

type ScopeKind = ReturnType<typeof parseScopeRef>['kind']

export type SessionIdentity = {
  kind: ScopeKind | 'unparsed'
  agentId: string
  projectId?: string | undefined
  taskId?: string | undefined
  roleName?: string | undefined
}
export type SessionMetadataScalar = string | number | boolean | null
export type SessionMetadataValue = SessionMetadataScalar | SessionMetadataScalar[]
export type SessionMetadata = {
  title?: string | undefined
  appearance?:
    | {
        color?: string | undefined
        terminalBg?: string | undefined
        terminalFg?: string | undefined
        [key: string]: unknown
      }
    | undefined
  [key: string]: unknown
}
export type SessionMetadataSource = 'launch' | 'hrc' | 'api'
export type SessionMetadataSourceRecord = {
  source: SessionMetadataSource
  updatedBy: string
  updatedAt: string
  registered?: boolean | undefined
  shadowed?:
    | Array<{
        source: SessionMetadataSource
        value: SessionMetadataValue
        updatedBy: string
        updatedAt: string
      }>
    | undefined
}
export type SessionMetadataSources = Record<string, SessionMetadataSourceRecord>
export type SessionMetadataResponse = {
  metadata: SessionMetadata
  metadataSources: SessionMetadataSources
}
export type SessionMetadataTarget = { scopeRef: string; laneRef?: string | undefined }
export type PatchSessionMetadataRequest = SessionMetadataTarget & {
  set?: Record<string, unknown> | undefined
  clear?: string[] | undefined
}
export type SessionMetadataRejection = { key: string; reason: string }
export type SessionMetadataValidation = {
  values: Record<string, SessionMetadataValue>
  rejected: SessionMetadataRejection[]
}

export const SESSION_TITLE_MAX_LENGTH = 200
export const SESSION_METADATA_MAX_KEYS = 64
export const SESSION_METADATA_KEY_MAX_BYTES = 128
export const SESSION_METADATA_VALUE_MAX_BYTES = 4096
const byteLength = (value: string): number => new TextEncoder().encode(value).length
const KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}(\.[a-z][a-zA-Z0-9]{0,63}){0,3}$/
const scalar = (value: unknown): value is SessionMetadataScalar =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value))

export function boundedText(
  maxLength: number
): (value: SessionMetadataValue) => string | undefined {
  return (value) =>
    typeof value !== 'string'
      ? 'must be a string'
      : !value.trim()
        ? 'must be non-empty'
        : value.trim().length > maxLength
          ? `must be at most ${maxLength} characters`
          : [...value.trim()].some((character) => {
                const code = character.codePointAt(0) ?? 0
                return code < 32 || code === 127
              })
            ? 'must not contain control characters'
            : undefined
}
export function hexColor(value: SessionMetadataValue): string | undefined {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? undefined
    : 'must be a #RRGGBB hex color'
}
export const REGISTERED_SESSION_METADATA = {
  title: { validate: boundedText(SESSION_TITLE_MAX_LENGTH), projects: 'session_index.title' },
  'appearance.color': { validate: hexColor },
  'appearance.terminalBg': { validate: hexColor },
} as const

export function validateSessionMetadataEntry(
  key: string,
  value: unknown,
  registered = true
): { value?: SessionMetadataValue | undefined; reason?: string | undefined } {
  if (!KEY_PATTERN.test(key) || byteLength(key) > SESSION_METADATA_KEY_MAX_BYTES)
    return {
      reason: 'key must have 1–4 valid segments (at most 64 characters each) and at most 128 bytes',
    }
  if (!(scalar(value) || (Array.isArray(value) && value.every(scalar))))
    return { reason: 'value must be a JSON scalar or array of scalars' }
  if (byteLength(JSON.stringify(value)) > SESSION_METADATA_VALUE_MAX_BYTES)
    return { reason: 'serialized value must be at most 4096 bytes' }
  const rule = Object.hasOwn(REGISTERED_SESSION_METADATA, key)
    ? REGISTERED_SESSION_METADATA[key as keyof typeof REGISTERED_SESSION_METADATA]
    : undefined
  const reason = registered && rule ? rule.validate(value) : undefined
  if (reason) return { reason }
  return {
    value: key === 'title' && registered && typeof value === 'string' ? value.trim() : value,
  }
}

/** Only flattens/validates shape; registered meanings are checked by HRC at write. */
export function flattenSessionMetadata(input: unknown): SessionMetadataValidation {
  const values: Record<string, SessionMetadataValue> = {}
  const rejected: SessionMetadataRejection[] = []
  const visit = (key: string, value: unknown): void => {
    const keyValidation = validateSessionMetadataEntry(key, null, false)
    if (keyValidation.reason) {
      rejected.push({ key, reason: keyValidation.reason })
      return
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [child, leaf] of Object.entries(value))
        visit(key ? `${key}.${child}` : child, leaf)
      return
    }
    const result = validateSessionMetadataEntry(key, value, false)
    const collision = Object.keys(values).find(
      (held) => held === key || held.startsWith(`${key}.`) || key.startsWith(`${held}.`)
    )
    if (result.reason || collision)
      rejected.push({ key, reason: result.reason ?? `key collides with ${collision}` })
    else values[key] = result.value as SessionMetadataValue
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    rejected.push({ key: '', reason: 'metadata must be an object' })
  else for (const [key, value] of Object.entries(input)) visit(key, value)
  return { values, rejected }
}

export function validateSessionMetadata(
  input: unknown,
  options: { existingKeys?: string[] | undefined; registered?: boolean | undefined } = {}
): SessionMetadataValidation {
  const flat = flattenSessionMetadata(input)
  const values: Record<string, SessionMetadataValue> = {}
  const rejected = [...flat.rejected]
  const held = new Set(options.existingKeys ?? [])
  for (const [key, value] of Object.entries(flat.values)) {
    const result = validateSessionMetadataEntry(key, value, options.registered !== false)
    const collision = [...held].find(
      (other) => other !== key && (other.startsWith(`${key}.`) || key.startsWith(`${other}.`))
    )
    const reason =
      result.reason ??
      (collision
        ? `key collides with ${collision}`
        : !held.has(key) && held.size >= SESSION_METADATA_MAX_KEYS
          ? 'continuity may hold at most 64 distinct keys'
          : undefined)
    if (reason) rejected.push({ key, reason })
    else {
      values[key] = result.value as SessionMetadataValue
      held.add(key)
    }
  }
  return { values, rejected }
}

export function nestSessionMetadata(values: Record<string, SessionMetadataValue>): SessionMetadata {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    const parts = key.split('.')
    let cursor = result
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(cursor, part)) cursor[part] = {}
      cursor = cursor[part] as Record<string, unknown>
    }
    cursor[parts.at(-1) as string] = value
  }
  return result as SessionMetadata
}

export function truncateMetadataUpdatedBy(value: string): string {
  if (byteLength(value) <= 256) return value
  let result = ''
  for (const character of value) {
    if (byteLength(`${result}${character}…`) > 256) break
    result += character
  }
  return `${result}…`
}

export const HRC_SESSION_METADATA_CHANGED_EVENT = 'session.metadata.changed'
export type HrcSessionMetadataChangedEventPayload = SessionMetadataTarget & {
  key: string
  source: SessionMetadataSource
  op: 'set' | 'clear'
  resolved: { value: SessionMetadataValue; source: SessionMetadataSource } | null
}

export function formatSessionIdentityHandle(identity: SessionIdentity): string {
  return (
    identity.agentId +
    (identity.projectId ? `@${identity.projectId}` : '') +
    (identity.taskId ? `:${identity.taskId}` : '') +
    (identity.roleName ? `/${identity.roleName}` : '')
  )
}

export type SessionGetResponse = SessionMetadataResponse & {
  continuity: { scopeRef: string; laneRef: string }
  identity: SessionIdentity
  generation: {
    hostSessionId: string
    generation: number
    status: string
    createdAt: string
    lastAppliedIntent?: unknown
    continuation?: unknown
  }
  facts: {
    effectiveStatus: string
    executionMode?: string | undefined
    lastActivityAt?: string | undefined
  }
}
