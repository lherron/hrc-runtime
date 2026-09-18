import { type HrcSelector, parseSelector } from 'hrc-core'
import { resolveProfileAwareScopeInput, writePlacementWarnings } from 'hrc-sdk'

/**
 * Enrich only unprefixed target handles. Object selectors and every prefixed
 * selector retain the pure parser's existing behavior.
 */
export async function parseProfileAwareSelector(input: unknown): Promise<HrcSelector> {
  const parsed = parseSelector(input)
  if (parsed.kind !== 'target' || typeof input !== 'string') return parsed

  const resolved = await resolveProfileAwareScopeInput(input, {
    placement: { taskWorktreeAssociation: 'advisory' },
  })
  writePlacementWarnings('hrc', resolved.placement.warnings)
  return parseSelector(input, {
    ...(resolved.defaultRoleName !== undefined
      ? { defaultRoleName: resolved.defaultRoleName }
      : {}),
  })
}
