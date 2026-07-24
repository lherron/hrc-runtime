import { parseScopeRef } from 'agent-scope'
import { HrcConflictError, HrcErrorCode } from 'hrc-core'

import { writeServerLog } from './server-log.js'

export type LocalPersonaPolicyContext = {
  readonly options?:
    | {
        readonly localPersonaAllowlist?: readonly string[] | undefined
      }
    | undefined
}

/**
 * Normalize the operator's typed daemon input once at startup.
 *
 * `undefined` preserves the historical unrestricted behavior. An explicitly
 * empty list is meaningful and denies every local agent scope.
 */
export function normalizeLocalPersonaAllowlist(
  input: readonly string[] | undefined
): readonly string[] | undefined {
  if (input === undefined) return undefined

  const normalized = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') {
      throw new Error('local persona allowlist entries must be strings')
    }
    const agentId = raw.trim()
    try {
      parseScopeRef(`agent:${agentId}`)
    } catch (error) {
      throw new Error(
        `invalid local persona allowlist entry ${JSON.stringify(raw)}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    normalized.add(agentId)
  }
  return Object.freeze([...normalized])
}

/**
 * Fail closed before this daemon delivers to, summons, or starts a local agent
 * outside its operator-declared persona set.
 */
export function assertLocalPersonaAllowed(
  server: LocalPersonaPolicyContext,
  scopeRef: string
): void {
  const allowlist = server.options?.localPersonaAllowlist
  if (allowlist === undefined) return

  const agentId = parseScopeRef(scopeRef).agentId
  if (allowlist.includes(agentId)) return

  const diagnostic = `local persona allowlist rejected agent "${agentId}" for scope "${scopeRef}"; allowed personas: ${
    allowlist.length === 0 ? '(none)' : allowlist.join(', ')
  }`
  writeServerLog('WARN', 'local_persona_policy.refusal', {
    agentId,
    scopeRef,
    allowedPersonaIds: allowlist,
  })
  throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
    scopeRef,
    agentId,
    reason: 'local-persona-not-allowed',
    allowedPersonaIds: allowlist,
  })
}
