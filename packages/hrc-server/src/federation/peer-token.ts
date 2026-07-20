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
 * The secret leaves only through an explicit `reveal()` call, which exists so
 * the F1 transport can set an Authorization header and for nothing else. That
 * makes leaks opt-in and greppable rather than accidental.
 */

export const REDACTED_PEER_TOKEN = '[REDACTED]'

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom')

export class PeerToken {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  /** The only way to obtain the secret. Call sites are intentionally few. */
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
