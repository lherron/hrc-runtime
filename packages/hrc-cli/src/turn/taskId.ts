/**
 * Task-id extraction helpers, relocated here by affinity (T-04735).
 *
 * Two genuinely distinct grammars share one home without being merged:
 *  - `taskIdFromScope`      — regex match on a scope/handle string
 *    (e.g. `agent:larry:project:agent-spaces:task:T-01449` or `larry@…:T-01449`).
 *  - `taskIdFromSessionRef` — `:task:<id>` segment scan on a sessionRef string
 *    (lane suffix stripped first).
 *
 * They accept different input shapes by design; collapsing them into a single
 * parser would be wrong.
 */

import { parseTaskId } from 'hrc-core'

/**
 * Extract a task id from a scope/handle string by regex, at the start of the
 * string or after a `:` separator. A subtask scope (`…:T-12345.slug`) reports
 * the subtask id, never its owner; a legacy `T-<n>` outside the grammar still
 * matches as before.
 */
export function taskIdFromScope(scope: string): string | undefined {
  const token = scope.match(/(?:^|:)(T-\d+)(\.[^:/@\s]*)?/)
  if (!token) return undefined
  const [, ownerToken, suffix = ''] = token
  return parseTaskId(`${ownerToken}${suffix}`)?.id ?? ownerToken
}

/**
 * Extract a task id from a sessionRef by scanning for a `:task:<id>` segment.
 * Strips any lane suffix (`/lane:…`) before scanning. Returns undefined when
 * no `task` segment carries a following id.
 */
export function taskIdFromSessionRef(sessionRef: string): string | undefined {
  // Strip lane suffix and scan for `:task:<id>`.
  const scopePart = sessionRef.split('/')[0] ?? sessionRef
  const parts = scopePart.split(':')
  const taskIdx = parts.indexOf('task')
  if (taskIdx >= 0 && parts[taskIdx + 1]) {
    return parts[taskIdx + 1]
  }
  return undefined
}
