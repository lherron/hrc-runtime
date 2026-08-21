/**
 * The server-side dispatch boundary for `intent.provision` (T-07398 Wave 2b).
 *
 * The sender already validated the directive block against the resolved
 * harness's vocabulary. The server re-validates anyway, because "the sender
 * checked" is not a property of a request body: anything that can POST a
 * `runtimeIntent` can spell a denied key by hand, and the deny-list is a
 * security boundary, not a UX affordance.
 *
 * Two rules, and only two:
 *
 *  - SHAPE, checked structurally rather than against a key list. A block is a
 *    flat table of top-level scalars; a nested table (`{claude: {...}}`) or a
 *    non-scalar value for any key is refused. Stating it as shape rather than
 *    as an enumeration is what closes the nested-spelling bypass class for keys
 *    nobody has invented yet — `codex.sandbox_mode`, `claude.permission_mode`,
 *    `claude.args` are all excluded by the same one sentence.
 *  - DENY, taken from the ONE shared constant (`DENIED_PROVISION_OVERRIDE_KEYS`,
 *    public via agent-scope) rather than restated here, so the sender and the
 *    server can never disagree about what is refused.
 *
 * Unknown top-level scalars deliberately pass: the spec's surface is a
 * deny-list, so a future `[provisioning]` scalar is overridable out of the box.
 * `UNKNOWN_PROVISION_KEY` is the SENDER's judgement (Wave 2a), made where the
 * profile's vocabulary is actually in hand.
 */

import { DENIED_PROVISION_OVERRIDE_KEYS } from 'agent-scope'
import type { ProvisioningScalars } from 'agent-scope'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { isRecord } from './common.js'

function isScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/**
 * Validate a `provision` block from a request body and return it VERBATIM.
 *
 * Verbatim is deliberate: this boundary refuses or passes through, it never
 * normalizes. A block that reached the summon gate in a different shape than
 * the sender wrote would make the sender's own typed errors unreproducible.
 */
export function parseOptionalProvisionBlock(
  value: unknown,
  field = 'runtimeIntent.provision'
): Partial<ProvisioningScalars> | undefined {
  if (value === undefined) return undefined
  // `isRecord` admits arrays (typeof [] === 'object'), and an array would then
  // pass the member loop vacuously and read as an empty block. A table is not a
  // list: refuse it here rather than silently accepting "no directives".
  if (!isRecord(value) || Array.isArray(value)) {
    throw new HrcDomainError(
      HrcErrorCode.INVALID_PROVISION_SHAPE,
      `${field} must be a table of top-level provisioning scalars`,
      { field, retryable: false }
    )
  }

  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) continue
    if (!isScalar(member)) {
      throw new HrcDomainError(
        HrcErrorCode.INVALID_PROVISION_SHAPE,
        `${field}.${key} must be a scalar: nested provisioning tables are profile-only and can never be set per-summon`,
        { field: `${field}.${key}`, retryable: false }
      )
    }
  }

  for (const denied of DENIED_PROVISION_OVERRIDE_KEYS) {
    if (value[denied] === undefined) continue
    throw new HrcDomainError(
      HrcErrorCode.DENIED_PROVISION_KEY,
      `${field}.${denied} is denied: "${denied}" can only be set in the agent profile ` +
        `(denied keys: ${DENIED_PROVISION_OVERRIDE_KEYS.join(', ')})`,
      { field: `${field}.${denied}`, retryable: false }
    )
  }

  return value as Partial<ProvisioningScalars>
}
