import { getAspHome } from 'spaces-config'

/**
 * The `aspHome` / `spec` / `cwd` triad that the agent-spaces request types
 * (RunTurnNonInteractiveRequest, BuildProcessInvocationSpecRequest) require but
 * IGNORE when `placement` is set — agent-spaces resolves everything from the
 * placement instead (see client.ts buildPlacementInvocationSpec).
 *
 * Centralized so the placeholder values (and this explanatory comment) live in
 * one place instead of being duplicated across the SDK and CLI request builders.
 */
export function placementPlaceholders(): { aspHome: string; spec: { spaces: [] }; cwd: string } {
  return {
    aspHome: getAspHome(),
    spec: { spaces: [] },
    cwd: '/',
  }
}
