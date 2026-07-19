/**
 * Shared, private monitor `--until` condition constants and validation.
 *
 * Previously `VALID_CONDITIONS`, `MSG_REQUIRED_CONDITIONS`, and `POLL_MS` were
 * declared identically in `monitor-watch.ts` and `monitor-wait.ts`, and the
 * "invalid condition" usage message was duplicated at both `--until`
 * validation sites. Consolidated here verbatim (behavior-preserving).
 */

import { CliUsageError } from 'cli-kit'

export const VALID_CONDITIONS = new Set<string>([
  'turn-finished',
  'idle',
  'busy',
  'response',
  'runtime-dead',
])

export const MSG_REQUIRED_CONDITIONS = new Set<string>(['response'])

export const POLL_MS = 100

/**
 * Throws the canonical CLI usage error if `until` is a defined-but-invalid
 * condition. A `undefined` value passes (callers enforce required-ness
 * separately). Error message is byte-identical to the previous inline checks.
 */
export function assertValidUntilCondition(until: string | undefined): void {
  if (until !== undefined && !VALID_CONDITIONS.has(until)) {
    throw new CliUsageError(
      `invalid condition: ${until} (valid: ${[...VALID_CONDITIONS].join(', ')})`
    )
  }
}
