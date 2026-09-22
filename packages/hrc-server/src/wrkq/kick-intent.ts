import { parseScopeRef, resolveQualifiedScopeInput } from 'agent-scope'
import { buildInvalidProfileWarning } from 'hrc-core'
import type { HrcRuntimeIntent } from 'hrc-core'

import { withAspdObservationSession } from '../agent-spaces-adapter/aspd-observation-client.js'
import { observedRuntimeBundle } from '../observed-runtime-bundle.js'
import { resolvePlacementInProcess } from '../placements-resolve.js'

/**
 * Build the runtime intent for a target the LEDGER addressed but this node has
 * never seated (T-07612 §5, §10).
 *
 * wrkq stores `materialization_intent` as the VERBATIM `+node=`/`+model=`
 * directive block and never parses it — that vocabulary is HRC's, applied at
 * kick. So the daemon assembles the intent itself, from ASP declaration
 * observations on this node's filesystem, with the directive block overlaid
 * aspd-side last.
 *
 * That ownership is the point rather than an implementation detail: placement
 * is execution, and an intent that arrived over the wire from a sender would be
 * the origin node's paths, not this one's.
 *
 * T-08597: async over in-process aspd observation (no self-HTTP). An
 * unresolvable agent or project resolves to `undefined` (the kicker refuses
 * the birth); an uninterpretable declaration fails closed the same way. An
 * invalid-but-present profile births target-only with the stripped-provisioning
 * WARN on stderr, exactly as the local assembler did.
 */
export async function buildKickRuntimeIntent(
  scopeRef: string,
  materializationIntent: string | undefined,
  options: { env?: Record<string, string | undefined>; cwd?: string } = {}
): Promise<HrcRuntimeIntent | undefined> {
  const cwd = options.cwd ?? process.cwd()
  const parsed = parseScopeRef(scopeRef)
  const provision = parseKickDirectives(scopeRef, materializationIntent)

  let projectRoot: string | undefined
  let placementCwd: string
  try {
    const placement = await resolvePlacementInProcess({
      agentId: parsed.agentId,
      ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
      cwd,
      runMode: 'task',
    })
    if (placement.agentRoot === undefined) return undefined
    projectRoot = placement.projectRoot
    placementCwd = placement.cwd ?? cwd
  } catch {
    return undefined
  }

  const directives =
    provision === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(provision).filter(
            ([, value]) =>
              typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          )
        )

  try {
    return await withAspdObservationSession(['resolveRuntimeDeclaration'], async ({ client }) => {
      const declaration = await client.resolveRuntimeDeclaration({
        schemaVersion: 'aspc-resolve-runtime-declaration-request/v1',
        context: {
          agentId: parsed.agentId,
          project:
            projectRoot !== undefined
              ? {
                  mode: 'root',
                  projectRoot,
                  ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
                }
              : { mode: 'infer-from-cwd' },
          cwd: placementCwd,
          runMode: 'task',
          ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
          ...(directives !== undefined && Object.keys(directives).length > 0
            ? { provisionDirectives: directives as Record<string, string | number | boolean> }
            : {}),
        },
      })
      if (!declaration.ok) return undefined
      if (declaration.source.agentProfile.state === 'absent') return undefined
      if (declaration.source.agentProfile.state === 'invalid') {
        console.error(
          buildInvalidProfileWarning({
            agentId: parsed.agentId,
            agentRoot: declaration.placement.agentRoot,
            diagnosticMessages: declaration.diagnostics.map((diagnostic) => diagnostic.message),
            survivingProvisionKeys: Object.keys(declaration.provisioning.scalars),
          })
        )
      }
      const bundle = observedRuntimeBundle(declaration.placement.bundle)
      if (bundle === undefined) return undefined
      return {
        placement: {
          agentRoot: declaration.placement.agentRoot,
          ...(declaration.placement.projectRoot !== undefined
            ? { projectRoot: declaration.placement.projectRoot }
            : {}),
          cwd: declaration.placement.cwd,
          runMode: declaration.placement.runMode,
          bundle,
          dryRun: false,
        },
        // ASP realization is observation evidence, never selection authority
        // for the later ordinary v2 compile request.
        harness: { interactive: false },
        execution: { preferredMode: 'nonInteractive' },
      }
    })
  } catch {
    return undefined
  }
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
): Record<string, string | number | boolean> | undefined {
  const block = materializationIntent?.trim()
  if (block === undefined || block.length === 0) return undefined
  try {
    const resolved = resolveQualifiedScopeInput(
      `${scopeRef}${block.startsWith('+') ? '' : '+'}${block}`
    )
    const directives: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(resolved.directives ?? {})) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        directives[key] = value
      }
    }
    return directives
  } catch {
    return undefined
  }
}
