/** Task-id extraction from a human-supplied turn target handle (T-04735). */

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
