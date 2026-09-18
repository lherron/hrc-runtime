/**
 * T-08597 — daemon-backed runtime intent assembly (same name, same result
 * shape, async over the socket).
 *
 * The intent is assembled from the observed declaration
 * (`POST /v1/declarations/resolve`, aspd-backed) instead of local
 * `asp-targets.toml`/profile parsing. Per-summon directive blocks ride as
 * `provision` and are overlaid aspd-side; the stripped-provisioning WARN the
 * local assembler printed on stderr is re-emitted here from the route's
 * warnings. A missing/unreachable daemon socket is a typed
 * `runtime_unavailable` HrcDomainError.
 */

import {
  type BuildHrcRuntimeIntentInput,
  HrcDomainError,
  HrcErrorCode,
  type HrcRuntimeIntent,
  resolveControlSocketPath,
} from 'hrc-core'

import { HrcClient } from './client.js'
import { discoverSocket } from './discover.js'

function placementClient(socketPath: string | undefined): HrcClient {
  if (socketPath !== undefined) return new HrcClient(socketPath)
  try {
    return new HrcClient(discoverSocket())
  } catch {
    const path = resolveControlSocketPath()
    throw new HrcDomainError(
      HrcErrorCode.RUNTIME_UNAVAILABLE,
      `HRC daemon socket not found at ${path}. Is the HRC server running?`,
      { code: 'hrc_daemon_missing_socket', socketPath: path }
    )
  }
}

/**
 * Assemble an {@link HrcRuntimeIntent} from a resolved placement. The provider
 * and harness id are observed from the agent declaration; the placement and
 * the caller-supplied interaction semantics are passed through unchanged.
 */
export async function buildHrcRuntimeIntent(
  input: BuildHrcRuntimeIntentInput
): Promise<HrcRuntimeIntent> {
  const response = await placementClient(input.socketPath).resolveRuntimeIntent({
    agentId: input.agentId,
    agentRoot: input.agentRoot,
    ...(input.projectRoot !== undefined ? { projectRoot: input.projectRoot } : {}),
    cwd: input.cwd ?? input.projectRoot ?? input.agentRoot,
    runMode: input.runMode ?? 'task',
    interactive: input.interactive ?? false,
    preferredMode: input.preferredMode ?? 'nonInteractive',
    ...(input.allowInteractiveSurfaceReuse !== undefined
      ? { allowInteractiveSurfaceReuse: input.allowInteractiveSurfaceReuse }
      : {}),
    ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
    ...(input.provision !== undefined ? { provision: input.provision } : {}),
  })
  for (const warning of response.declaration.warnings) {
    console.error(warning)
  }
  return response.intent
}
