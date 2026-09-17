import { validateToken } from 'agent-scope'

import { HrcBadRequestError, HrcErrorCode } from './errors.js'
import { normalizeSessionRef } from './selectors.js'

/**
 * HRC app-session identity (T-08576). An app session is a second, HRC-owned scope
 * kind: `app:<appId>` with lane `<appSessionKey>`. Agent ScopeRef grammar keeps
 * rejecting it; only these helpers classify it. Writes validate, reads classify.
 */
export const APP_SESSION_SCOPE_PREFIX = 'app:'

/** Identity-class environment keys an app harness may only receive from HRC. */
export const APP_IDENTITY_ENV_KEYS = [
  'AGENT_ID',
  'AGENT_ACTOR',
  'WRKQ_ACTOR',
  'ASP_AGENT_ID',
  'AGENT_SCOPE_REF',
  'AGENT_LANE_REF',
  'AGENT_LANE',
  'AGENT_SESSION_REF',
  'HRC_SESSION_REF',
  'ASP_SCOPE_REF',
  'ASP_HANDLE',
  'AGENT_PROJECT',
  'ASP_DEFAULT_TASK',
  'AGENT_HOST_SESSION_ID',
  'HRC_HOST_SESSION_ID',
  'AGENT_RUN_ID',
  'HRC_RUN_ID',
  'AGENT_GENERATION',
  'HRC_GENERATION',
] as const

export type AppSessionSelector = { appId: string; appSessionKey: string }

export function validateAppSessionSelector(selector: AppSessionSelector): void {
  for (const field of ['appId', 'appSessionKey'] as const) {
    const reason = validateToken(selector[field], field)
    if (reason !== undefined) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `selector.${field}: ${reason}`, {
        field: `selector.${field}`,
        reason,
      })
    }
  }
}

export function formatAppSessionScopeRef(appId: string): string {
  validateAppSessionSelector({ appId, appSessionKey: 'main' })
  return `${APP_SESSION_SCOPE_PREFIX}${appId}`
}

/** Classify without validating grammar, so legacy rows stay readable. */
export function parseAppSessionScopeRef(scopeRef: string): { appId: string } | null {
  if (!scopeRef.startsWith(APP_SESSION_SCOPE_PREFIX)) return null
  const appId = scopeRef.slice(APP_SESSION_SCOPE_PREFIX.length)
  return appId.length > 0 ? { appId } : null
}

export function appSessionSelectorKey(selector: AppSessionSelector): string {
  return `${selector.appId}\u0000${selector.appSessionKey}`
}

/**
 * Stored session ref for a (scope, lane) row. App scopes are formatted verbatim;
 * every other scope keeps the agent-grammar normalization, including its throws.
 */
export function formatStoredSessionRef(scopeRef: string, laneRef: string): string {
  if (parseAppSessionScopeRef(scopeRef) !== null) {
    return `${scopeRef}/lane:${laneRef}`
  }
  return normalizeSessionRef(`${scopeRef}/lane:${laneRef}`)
}
