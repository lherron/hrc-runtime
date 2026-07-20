/**
 * Node identity grammar (federation spec §3).
 *
 * A nodeId is a standard token `[A-Za-z0-9._-]{1,64}`. The literal `local` is
 * reserved as the placement sentinel (`default_home_node = "local"`, §5) and can
 * never name a real node.
 *
 * No network concern lives here — this is pure grammar, shared by daemon
 * identity, peer config keys, and (later) the placement ledger.
 */

export const NODE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Reserved words that may never be a real nodeId.
 *
 * Matched case-insensitively, deliberately stricter than the spec's "the
 * literal `local`": the placement stanza compares against lowercase `local`, so
 * a node calling itself `Local` would read as a distinct node to the compiler
 * while reading as the sentinel to every human. Rejecting the whole case-fold
 * closes that gap; no legitimate node wants any casing of the word.
 */
export const RESERVED_NODE_IDS: readonly string[] = ['local']

export type NodeId = string & { readonly __nodeIdBrand: unique symbol }

export function isReservedNodeId(value: string): boolean {
  return RESERVED_NODE_IDS.includes(value.toLowerCase())
}

export function isValidNodeId(value: string): value is NodeId {
  return NODE_ID_PATTERN.test(value) && !isReservedNodeId(value)
}

/**
 * Returns the reason `value` is not a usable nodeId, or undefined if it is.
 *
 * Callers render this into a startup diagnostic, so every branch names the
 * specific problem rather than saying "invalid".
 */
export function describeNodeIdViolation(value: string): string | undefined {
  if (value.length === 0) return 'it is empty'
  if (value.length > 64) return `it is ${value.length} characters (maximum 64)`
  if (!NODE_ID_PATTERN.test(value)) {
    const offending = [...value].filter((char) => !/[A-Za-z0-9._-]/.test(char))
    const unique = [...new Set(offending)]
    return `it contains disallowed character(s) ${unique
      .map((char) => JSON.stringify(char))
      .join(', ')} (allowed: A-Z a-z 0-9 . _ -)`
  }
  if (isReservedNodeId(value)) {
    return 'it is the reserved placement sentinel "local" (federation spec §5)'
  }
  return undefined
}

/**
 * Validates `value` as a nodeId, throwing a diagnostic that names both the
 * configuration surface (`context`) and the specific violation.
 */
export function parseNodeId(value: string, context: string): NodeId {
  const violation = describeNodeIdViolation(value)
  if (violation !== undefined) {
    throw new Error(`${context} is not a valid nodeId (${JSON.stringify(value)}): ${violation}`)
  }
  return value as NodeId
}
