/**
 * CLI adapter for hrc-adapter-agent-spaces.
 *
 * Translates HRC harness intent + placement into a CLI invocation spec
 * using public agent-spaces APIs only. Phase 1 interactive harnesses only.
 *
 * References: T-00960, T-00946
 */

import {
  type BuildProcessInvocationSpecRequest,
  type BuildProcessInvocationSpecResponse,
  createAgentSpacesClient,
} from 'agent-spaces'
import type {
  HrcContinuationRef,
  HrcHarness,
  HrcIoMode,
  HrcLaunchEnvConfig,
  HrcProvider,
  HrcRuntimeIntent,
} from 'hrc-core'
import { type ResolvedRuntimeBundle, getAspHome } from 'spaces-config'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Phase 1 supported interactive CLI harnesses */
const SUPPORTED_CLI_HARNESSES: ReadonlySet<HrcHarness> = new Set<HrcHarness>([
  'claude-code',
  'codex-cli',
])

type CliFrontend = 'claude-code' | 'codex-cli'

/** Map provider → CLI frontend for interactive mode */
const PROVIDER_TO_FRONTEND: Record<HrcProvider, CliFrontend> = {
  anthropic: 'claude-code',
  openai: 'codex-cli',
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Spec builder function — allows injection for testing */
export type SpecBuilder = (
  req: BuildProcessInvocationSpecRequest
) => Promise<BuildProcessInvocationSpecResponse>

/** Optional configuration for buildCliInvocation */
export interface BuildCliInvocationOptions {
  specBuilder?: SpecBuilder | undefined
  continuation?: HrcContinuationRef | undefined
}

/** Result of building a CLI invocation from HRC intent */
export interface CliInvocationResult {
  argv: string[]
  env: Record<string, string>
  cwd: string
  provider: HrcProvider
  frontend: CliFrontend
  interactionMode: 'headless' | 'interactive'
  ioMode: HrcIoMode
  resolvedBundle?: ResolvedRuntimeBundle | undefined
  warnings?: string[] | undefined
}

/** Error thrown when an unsupported harness is requested */
export class UnsupportedHarnessError extends Error {
  readonly code = 'unsupported_harness' as const
  readonly harness: string

  constructor(harness: string) {
    super(
      `Unsupported interactive harness "${harness}". ` +
        `Phase 1 supports: ${[...SUPPORTED_CLI_HARNESSES].join(', ')}`
    )
    this.name = 'UnsupportedHarnessError'
    this.harness = harness
  }
}

// ---------------------------------------------------------------------------
// Env merging
// ---------------------------------------------------------------------------

/**
 * Merge environment variables according to HRC launch env policy:
 * 1. Start with base env
 * 2. Apply `launch.env` overrides (overwrites existing keys)
 * 3. Remove keys listed in `launch.unsetEnv`
 * 4. Prepend `launch.pathPrepend` entries to PATH
 */
export function mergeEnv(
  baseEnv: Record<string, string>,
  launchConfig?: HrcLaunchEnvConfig | undefined
): Record<string, string> {
  const merged = { ...baseEnv }

  if (!launchConfig) return merged

  // Apply overrides
  if (launchConfig.env) {
    for (const [k, v] of Object.entries(launchConfig.env)) {
      merged[k] = v
    }
  }

  // Remove unset keys
  if (launchConfig.unsetEnv) {
    for (const key of launchConfig.unsetEnv) {
      delete merged[key]
    }
  }

  // Prepend to PATH
  if (launchConfig.pathPrepend && launchConfig.pathPrepend.length > 0) {
    const currentPath = merged['PATH'] ?? ''
    const prepend = launchConfig.pathPrepend.join(':')
    merged['PATH'] = currentPath ? `${prepend}:${currentPath}` : prepend
  }

  return merged
}

// ---------------------------------------------------------------------------
// Internal: resolve frontend from intent
// ---------------------------------------------------------------------------

function resolveCliFrontend(intent: HrcRuntimeIntent): CliFrontend {
  if (!intent.harness.interactive) {
    throw new UnsupportedHarnessError('non-interactive')
  }

  const frontend = PROVIDER_TO_FRONTEND[intent.harness.provider]
  if (!frontend || !SUPPORTED_CLI_HARNESSES.has(frontend)) {
    throw new UnsupportedHarnessError(intent.harness.provider)
  }

  return frontend
}

// ---------------------------------------------------------------------------
// Internal: build HRC correlation env vars from placement
// ---------------------------------------------------------------------------

function buildHrcCorrelationEnv(intent: HrcRuntimeIntent): Record<string, string> {
  const env: Record<string, string> = {}
  const correlation = intent.placement?.correlation

  if (correlation?.sessionRef) {
    env['HRC_SESSION_REF'] = `${correlation.sessionRef.scopeRef}/${correlation.sessionRef.laneRef}`
  }

  if (correlation?.hostSessionId) {
    env['HRC_HOST_SESSION_ID'] = correlation.hostSessionId
  }

  if (correlation?.runId) {
    env['HRC_RUN_ID'] = correlation.runId
  }

  return env
}

// ---------------------------------------------------------------------------
// Default spec builder using real agent-spaces client
// ---------------------------------------------------------------------------

function defaultSpecBuilder(): SpecBuilder {
  const client = createAgentSpacesClient()
  return (req) => client.buildProcessInvocationSpec(req)
}

function resolveInvocationModes(intent: HrcRuntimeIntent): {
  interactionMode: 'headless' | 'interactive'
  ioMode: HrcIoMode
} {
  const preferredMode = intent.execution?.preferredMode
  // HRC only has a true detached headless lifecycle for Codex today.
  // Claude must stay interactive so the tmux runtime remains attachable.
  if (
    intent.harness.provider === 'openai' &&
    (preferredMode === 'headless' || preferredMode === 'nonInteractive')
  ) {
    return {
      interactionMode: 'headless',
      ioMode: 'pipes',
    }
  }

  return {
    interactionMode: 'interactive',
    ioMode: 'pty',
  }
}

// ---------------------------------------------------------------------------
// Core adapter function
// ---------------------------------------------------------------------------

/**
 * Build a CLI invocation spec from HRC runtime intent.
 *
 * Uses the public `agent-spaces` placement API to resolve the bundle and
 * construct argv/env/cwd. Applies HRC launch env policy on top of the
 * base env returned by agent-spaces, and injects HRC correlation env vars.
 *
 * Pass `options.specBuilder` to inject a stub for testing.
 *
 * @throws {UnsupportedHarnessError} if the harness is not a phase 1 interactive harness
 */
export async function buildCliInvocation(
  intent: HrcRuntimeIntent,
  options?: BuildCliInvocationOptions
): Promise<CliInvocationResult> {
  const frontend = resolveCliFrontend(intent)
  const { interactionMode, ioMode } = resolveInvocationModes(intent)

  const specBuilder = options?.specBuilder ?? defaultSpecBuilder()

  // Use the placement-based path: when placement is set, aspHome/spec/cwd
  // are ignored by agent-spaces (see client.ts buildPlacementInvocationSpec).
  const placementReq: BuildProcessInvocationSpecRequest = {
    placement: intent.placement,
    provider: intent.harness.provider,
    frontend,
    model: intent.harness.model,
    interactionMode,
    ioMode,
    ...(options?.continuation ? { continuation: options.continuation } : {}),
    ...(intent.harness.yolo ? { yolo: true } : {}),
    ...(options?.continuation === undefined && intent.initialPrompt !== undefined
      ? { prompt: intent.initialPrompt }
      : {}),
    // Required by the type but ignored when placement is set
    aspHome: getAspHome(),
    spec: { spaces: [] },
    cwd: '/',
  }

  const response = await specBuilder(placementReq)
  const argv =
    frontend === 'codex-cli' &&
    interactionMode === 'headless' &&
    !response.spec.argv.includes('--json')
      ? [...response.spec.argv, '--json']
      : response.spec.argv

  // Build HRC correlation env vars from placement
  const correlationEnv = buildHrcCorrelationEnv(intent)

  // Merge: agent-spaces base env → HRC correlation → launch overrides/unset/pathPrepend
  const envWithCorrelation = { ...response.spec.env, ...correlationEnv }
  const finalEnv = mergeEnv(envWithCorrelation, intent.launch)

  return {
    argv,
    env: finalEnv,
    cwd: response.spec.cwd,
    provider: intent.harness.provider,
    frontend,
    interactionMode,
    ioMode,
    resolvedBundle: response.resolvedBundle,
    warnings: response.warnings,
  }
}
