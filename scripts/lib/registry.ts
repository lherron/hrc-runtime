/**
 * The one canonical Verdaccio registry for this fleet.
 *
 * A bun.lock is SHARED history: every tarball URL it records is resolved
 * verbatim by every other node. A lock synced on a host that reaches its
 * registry by a machine-local name therefore makes the repo uninstallable
 * everywhere else — hrc-runtime main carried 26 `http://127.0.0.1:4873/`
 * tarball URLs on 2026-08-21 and died with ConnectionRefused on max3 (T-07412).
 */
export const CANONICAL_REGISTRY_URL = 'http://mini:4873/'

/**
 * The registry THIS process publishes to and installs from. A node may
 * legitimately point at its own Verdaccio — a Tart guest has no route to
 * `mini` — which is exactly how a loopback URL reaches a lock in the first
 * place. `checkLockHygiene` deliberately does NOT read this: the host a lock
 * is allowed to name is a property of the repo, not of the node that synced it.
 */
export function activeRegistryUrl(
  environment: Record<string, string | undefined> = process.env
): string {
  // Destructure rather than index/property access: consumers span tsconfigs
  // that require bracket access on index signatures
  // (noPropertyAccessFromIndexSignature) and biome configs that forbid it
  // (useLiteralKeys); destructuring satisfies both.
  const { VERDACCIO_REGISTRY } = environment
  return VERDACCIO_REGISTRY ?? CANONICAL_REGISTRY_URL
}

/** `http://mini:4873/` -> `mini:4873`. Throws on a value that is not a URL. */
export function registryOrigin(url: string): string {
  return new URL(url).host
}

export type LockViolation = { line: number; host: string; url: string }

const URL_PATTERN = /https?:\/\/[^"'\s\\]+/g

/**
 * Every http(s) URL in a bun.lock whose host is not `canonicalUrl`'s host.
 *
 * The rule is deliberately total — EVERY URL, not just the ones that look like
 * a private registry — because every dependency this fleet installs comes
 * through mini's proxy. A public `registry.npmjs.org` tarball in the lock is
 * the same defect wearing a friendlier host: it means the lock was written
 * against a registry other than the canonical one.
 *
 * Pure: the caller supplies the content, so a fixture needs no repository.
 */
export function scanLockContent(
  content: string,
  canonicalUrl: string = CANONICAL_REGISTRY_URL
): LockViolation[] {
  const canonicalHost = registryOrigin(canonicalUrl)
  const violations: LockViolation[] = []
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(URL_PATTERN)) {
      const url = match[0]
      let host: string
      try {
        host = registryOrigin(url)
      } catch {
        continue
      }
      if (host !== canonicalHost) violations.push({ line: index + 1, host, url })
    }
  }
  return violations
}
