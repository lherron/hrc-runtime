import { type HrcSelector, parseSelector } from 'hrc-core'
import { resolveProfileAwareScopeInput } from 'hrc-sdk'

/**
 * Enrich only unprefixed target handles. Object selectors and every prefixed
 * selector retain the pure parser's existing behavior.
 */
export function parseProfileAwareSelector(input: unknown): HrcSelector {
  const parsed = parseSelector(input)
  if (parsed.kind !== 'target' || typeof input !== 'string') return parsed

  const resolved = resolveProfileAwareScopeInput(input)
  return parseSelector(input, {
    ...(resolved.defaultRoleName !== undefined
      ? { defaultRoleName: resolved.defaultRoleName }
      : {}),
  })
}
