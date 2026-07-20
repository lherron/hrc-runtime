/**
 * Opaque peer bearer token (federation spec §6).
 *
 * Token redaction is a day-one requirement, so the secret is held behind a
 * private field and every stringification path a leak could travel through is
 * overridden to yield `[REDACTED]`:
 *
 * - template literals / string concatenation → `toString`
 * - `JSON.stringify`, event payloads, HTTP bodies → `toJSON`
 * - `console.log` / `util.inspect` / Bun's inspector → the inspect custom hook
 *
 * The secret leaves only through the explicit outbound registry/peer transport
 * authorization-header call site. That makes leaks opt-in and greppable rather
 * than accidental. Comparison does not need it: `matches()` compares in
 * constant time inside the class, so authenticating a peer adds no egress path
 * at all.
 */

export const REDACTED_PEER_TOKEN = '[REDACTED]'

import { constantTimeEqual } from '../constant-time.js'

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom')

export class PeerToken {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  /**
   * Constant-time comparison against a candidate secret.
   *
   * This is the sanctioned way to authenticate an inbound bearer: the secret is
   * compared *inside* the token and never becomes a plain string at the call
   * site, so validating a peer adds no egress path.
   *
   * Comparison belongs on the receiving side, where an attacker can submit
   * guesses against a stored secret. A client setting its own Authorization
   * header is not a timing target and should use `reveal()` — swapping that to
   * `matches` would gain nothing.
   */
  matches(candidate: string): boolean {
    return constantTimeEqual(this.#value, candidate)
  }

  /**
   * The only way to obtain the secret. Call sites are intentionally limited to
   * the audited outbound Authorization header. Prefer `matches` for comparison.
   */
  reveal(): string {
    return this.#value
  }

  toString(): string {
    return REDACTED_PEER_TOKEN
  }

  toJSON(): string {
    return REDACTED_PEER_TOKEN
  }

  get [Symbol.toStringTag](): string {
    return REDACTED_PEER_TOKEN
  }

  [INSPECT_CUSTOM](): string {
    return REDACTED_PEER_TOKEN
  }
}
