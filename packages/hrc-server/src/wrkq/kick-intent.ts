import { parseScopeRef, resolveQualifiedScopeInput } from 'agent-scope'
import type { ProvisioningScalars } from 'agent-scope'
import { buildHrcRuntimeIntent } from 'hrc-core'
import type { HrcRuntimeIntent } from 'hrc-core'

import { resolveNodeLocalPlacement } from '../federation/summon-capability.js'

/**
 * Build the runtime intent for a target the LEDGER addressed but this node has
 * never seated (T-07612 §5, §10).
 *
 * wrkq stores `materialization_intent` as the VERBATIM `+node=`/`+model=`
 * directive block and never parses it — that vocabulary is HRC's, applied at
 * kick. So the daemon assembles the intent itself, from the target agent's own
 * profile on this node's filesystem, with the directive block overlaid last.
 *
 * That ownership is the point rather than an implementation detail: placement
 * is execution, and an intent that arrived over the wire from a sender would be
 * the origin node's paths, not this one's.
 */
export function buildKickRuntimeIntent(
  scopeRef: string,
  materializationIntent: string | undefined,
  options: { env?: Record<string, string | undefined>; cwd?: string } = {}
): HrcRuntimeIntent | undefined {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const resolution = resolveNodeLocalPlacement(scopeRef, { env, cwd })
  const placement = resolution.placement
  if (placement === undefined) return undefined

  const parsed = parseScopeRef(scopeRef)
  const provision = parseKickDirectives(scopeRef, materializationIntent)
  return buildHrcRuntimeIntent({
    agentId: parsed.agentId,
    agentRoot: placement.agentRoot,
    ...(placement.projectRoot === undefined ? {} : { projectRoot: placement.projectRoot }),
    cwd: placement.cwd,
    runMode: 'task',
    // Ledger traffic is work, not an operator sitting at a terminal.
    interactive: false,
    preferredMode: 'nonInteractive',
    ...(provision === undefined ? {} : { provision }),
  })
}

/**
 * Parse the `+` block wrkq carried verbatim.
 *
 * A malformed block must not strand the envelope: the directive is an override,
 * and losing it costs the sender their `+node=` preference, whereas refusing
 * the birth costs the addressee their message.
 */
function parseKickDirectives(
  scopeRef: string,
  materializationIntent: string | undefined
): Partial<ProvisioningScalars> | undefined {
  const block = materializationIntent?.trim()
  if (block === undefined || block.length === 0) return undefined
  try {
    const resolved = resolveQualifiedScopeInput(
      `${scopeRef}${block.startsWith('+') ? '' : '+'}${block}`
    )
    return resolved.directives
  } catch {
    return undefined
  }
}
