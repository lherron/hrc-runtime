/**
 * Node-local materialization capability observation (federation spec §5).
 *
 * These checks are evidence, never authority. They run only after the summon
 * gate has established that this node is home, and can only preserve that
 * allow or turn it into a visible refusal. All credential checks are explicit
 * presence heuristics: no secret values are read or logged, and no auth/network
 * probe runs on the summon path.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseScopeRef } from 'agent-scope'
import {
  HrcDomainError,
  HrcErrorCode,
  type HrcRuntimePlacement,
  type ResolvePlacementResponse,
  type WrkqProjectRegistryEntry,
} from 'hrc-core'
import type { AspcObserveRuntimeCapabilityRequest } from 'spaces-aspc-protocol'

import { withAspdObservationSession } from '../agent-spaces-adapter/aspd-observation-client.js'
import { resolvePlacementInProcess } from '../placements-resolve.js'

import type { SummonCapabilityHint, SummonCapabilityObservation } from './summon-gate.js'

/**
 * Harness driver ids, mirroring spaces-config HarnessId. HRC never interprets
 * the catalog: ids arrive either from the caller's hint or from aspd's
 * declaration observation (effectiveHarness); this union only names the values
 * the credential heuristics below switch over.
 */
export type HarnessId = 'claude' | 'claude-agent-sdk' | 'pi' | 'pi-sdk' | 'codex' | 'muse'

const HARNESS_IDS: ReadonlySet<string> = new Set<string>([
  'claude',
  'claude-agent-sdk',
  'pi',
  'pi-sdk',
  'codex',
  'muse',
])

function isHarnessId(value: string | undefined): value is HarnessId {
  return value !== undefined && HARNESS_IDS.has(value)
}

/** Structural copy of the harness availability report (was spaces-config HarnessDetection). */
export type HarnessDetection = {
  available: boolean
  version?: string | undefined
  path?: string | undefined
  capabilities?: string[] | undefined
  error?: string | undefined
}

export type SummonHarnessDetector = (harnessId: HarnessId) => Promise<HarnessDetection>

export type SummonCapabilityObserverOptions = {
  env?: Record<string, string | undefined> | undefined
  userHome?: string | undefined
  cwd?: string | undefined
  /** Test seam; production uses the registered ASP harness adapter. */
  detectHarness?: SummonHarnessDetector | undefined
}

const PRESENCE_HEURISTIC = 'presence-heuristic' as const

function incapable(
  capability: Exclude<SummonCapabilityObservation, { outcome: 'capable' }>['capability'],
  diagnostic: string,
  capabilityReason?: 'project-root-unresolvable'
): SummonCapabilityObservation {
  return {
    outcome: 'incapable',
    capability,
    diagnostic,
    ...(capabilityReason === undefined ? {} : { capabilityReason }),
    capabilitySource: PRESENCE_HEURISTIC,
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function nonEmptyEnv(env: Record<string, string | undefined>, key: string): boolean {
  return (env[key]?.trim().length ?? 0) > 0
}

/** Reads exactly one non-secret boolean from Claude's provisioning marker. */
function hasClaudeOnboardingMarker(path: string): boolean {
  try {
    const document = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return (
      typeof document === 'object' &&
      document !== null &&
      (document as Record<string, unknown>)['hasCompletedOnboarding'] === true
    )
  } catch {
    return false
  }
}

function adapterIdFor(
  hint: SummonCapabilityHint | undefined,
  observedEffectiveHarness: string | undefined
): HarnessId | undefined {
  const hrcHarness = hint?.harness?.id
  if (hrcHarness !== undefined) {
    switch (hrcHarness) {
      case 'agent-sdk':
        return 'claude-agent-sdk'
      case 'claude-code':
        return 'claude'
      case 'codex-cli':
        return 'codex'
      case 'pi':
      case 'pi-cli':
        return 'pi'
      case 'pi-sdk':
        return 'pi-sdk'
      case 'muse-cli':
        return 'muse'
    }
  }

  // The observed effective harness is already a catalog id (aspd resolves
  // the entry server-side); HRC never maps names itself. Unknown values fall
  // through to the incapable refusal below, never to a guessed driver.
  if (!isHarnessId(observedEffectiveHarness)) return undefined
  // Identity over HRC's own driver namespace: the observed id already names
  // the driver (no catalog mapping performed here). Frontend spellings only
  // arrive via the caller hint path above.
  switch (observedEffectiveHarness) {
    case 'claude':
      return 'claude'
    case 'claude-agent-sdk':
      return 'claude-agent-sdk'
    case 'pi':
      return 'pi'
    case 'pi-sdk':
      return 'pi-sdk'
    case 'codex':
      return 'codex'
    case 'muse':
      return 'muse'
    default:
      return undefined
  }
}

function credentialRefusal(
  harnessId: HarnessId,
  env: Record<string, string | undefined>,
  userHome: string
): SummonCapabilityObservation | undefined {
  switch (harnessId) {
    case 'claude':
    case 'claude-agent-sdk': {
      const marker = join(userHome, '.claude.json')
      if (nonEmptyEnv(env, 'ANTHROPIC_API_KEY') || hasClaudeOnboardingMarker(marker)) {
        return undefined
      }
      return incapable(
        'credentials',
        'anthropic credentials not observed: no ANTHROPIC_API_KEY and no ~/.claude.json with hasCompletedOnboarding=true — run claude login as this user'
      )
    }
    case 'codex': {
      const auth = join(userHome, '.codex', 'auth.json')
      if (nonEmptyEnv(env, 'OPENAI_API_KEY') || existsSync(auth)) return undefined
      return incapable(
        'credentials',
        'openai credentials not observed: no OPENAI_API_KEY and no ~/.codex/auth.json — run codex login as this user'
      )
    }
    case 'pi':
    case 'pi-sdk': {
      const auth = join(userHome, '.pi', 'agent', 'auth.json')
      if (existsSync(auth)) return undefined
      return incapable(
        'credentials',
        'pi credentials not observed: no ~/.pi/agent/auth.json — configure Pi authentication as this user'
      )
    }
    case 'muse': {
      // No file marker to check: muse authenticates through keychain-bound
      // oauth under the operator HOME, which the run env preserves. Auth
      // failures surface from the driver at runtime, not at summon.
      return undefined
    }
  }
}

export type HarnessCapabilityContext = {
  agentId: string
  agentRoot: string
  projectRoot?: string | undefined
  projectId?: string | undefined
  cwd: string
}

/**
 * T-08597: driver availability comes from aspd's bounded capability
 * observation, not an HRC-in-process adapter registry. `preparation: present`
 * is the composite "this node can launch this harness" fact; anything else
 * names its missing piece instead of launching into a crash.
 */
async function defaultDetectHarness(
  harnessId: HarnessId,
  context: HarnessCapabilityContext
): Promise<HarnessDetection> {
  try {
    return await withAspdObservationSession(['observeRuntimeCapability'], async ({ client }) => {
      const request: AspcObserveRuntimeCapabilityRequest = {
        schemaVersion: 'aspc-observe-runtime-capability-request/v1',
        harness: harnessId,
        context: {
          agentId: context.agentId,
          project:
            context.projectRoot !== undefined
              ? {
                  mode: 'root',
                  projectRoot: context.projectRoot,
                  ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
                }
              : { mode: 'infer-from-cwd' },
          cwd: context.cwd,
          runMode: 'task',
        },
      }
      const observed = await client.observeRuntimeCapability(request)
      if (!observed.ok) {
        return { available: false, error: observed.failure.message }
      }
      const problems: string[] = []
      if (observed.registration.state !== 'present')
        problems.push(`registration:${observed.registration.code}`)
      if (observed.nativeRuntime.state === 'absent')
        problems.push(`runtime:${observed.nativeRuntime.code}`)
      if (observed.credentials.state === 'absent')
        problems.push(`credentials:${observed.credentials.code}`)
      if (observed.preparation.state !== 'present')
        problems.push(`preparation:${observed.preparation.code}`)
      for (const diagnostic of observed.diagnostics) problems.push(diagnostic.message)
      if (problems.length > 0) {
        return { available: false, error: problems.join('; ') }
      }
      return { available: true }
    })
  } catch (error) {
    if (error instanceof HrcDomainError) throw error
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export type NodeLocalPlacementResolution = {
  placement?: HrcRuntimePlacement
  /** Observed effective harness id (aspd catalog id) behind the placement. */
  effectiveHarness?: string | undefined
  unresolvableProjectPath?: string
  missingAgentPath?: string
}

/**
 * Resolve placement from this node's filesystem only.
 *
 * Federated callers carry a useful harness/execution hint, but their absolute
 * placement paths belong to the origin node.  The receiver must rebuild those
 * paths from its own agent home and checkout collection before launching a
 * runtime.  The agent root gives us a deterministic collective-root fallback
 * when the daemon itself was launched from HOME rather than from a checkout.
 *
 * T-08597: async over the daemon's in-process aspd observation. HRC policy
 * (registry/marker/sibling/worktree) runs identically to the placements route;
 * agent existence, bundle, and harness facts are observed, never parsed.
 */
export type NodeLocalPlacementObservation = (
  input: Parameters<typeof resolvePlacementInProcess>[0],
  options?: { env?: Record<string, string | undefined> | undefined }
) => Promise<ResolvePlacementResponse>

export async function resolveNodeLocalPlacement(
  scopeRef: string,
  options: {
    env: Record<string, string | undefined>
    cwd: string
    /** Test seam; production reads the daemon registry. */
    registryProjects?: readonly WrkqProjectRegistryEntry[] | undefined
    /** Test seam; production observes via the in-process placements resolver. */
    observe?: NodeLocalPlacementObservation | undefined
  }
): Promise<NodeLocalPlacementResolution> {
  const parsed = parseScopeRef(scopeRef)
  const observe = options.observe ?? resolvePlacementInProcess
  let observed: Awaited<ReturnType<typeof resolvePlacementInProcess>>
  try {
    observed = await observe(
      {
        agentId: parsed.agentId,
        ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
        ...(parsed.taskId === undefined ? {} : { taskId: parsed.taskId }),
        cwd: options.cwd,
        runMode: 'task',
        // Advisory: capability observation reports checkout facts itself; a
        // git inspection failure here must warn, never refuse.
        taskWorktreeAssociation: 'advisory',
        ...(options.registryProjects === undefined
          ? {}
          : { registryProjects: [...options.registryProjects] }),
      },
      { env: options.env }
    )
  } catch (error) {
    if (
      error instanceof HrcDomainError &&
      error.code === HrcErrorCode.DECLARATION_INVALID &&
      (error.detail as { producerCode?: unknown } | undefined)?.producerCode === 'agent_not_found'
    ) {
      const searched = (error.detail as { searchedAgentRoots?: string[] }).searchedAgentRoots
      return {
        missingAgentPath: searched?.join(', ') ?? `<unresolved agent home for ${parsed.agentId}>`,
      }
    }
    // Infrastructure failures (aspd unreachable/unconfigured) and
    // non-project declaration failures must not masquerade as an
    // unresolvable project path: they are retryable or agent-scoped, while
    // the path outcome is a checkout fact. Plain errors from the observation
    // seam keep the historical collapse (the seam throws those only for
    // project resolution failures).
    if (error instanceof HrcDomainError && error.code === HrcErrorCode.RUNTIME_UNAVAILABLE) {
      throw error
    }
    if (
      error instanceof HrcDomainError &&
      error.code === HrcErrorCode.DECLARATION_INVALID &&
      (error.detail as { producerCode?: unknown } | undefined)?.producerCode !==
        'agent_not_found' &&
      (error.detail as { source?: unknown } | undefined)?.source !== 'project-targets'
    ) {
      throw error
    }
    if (parsed.projectId === undefined) throw error
    return { unresolvableProjectPath: join(options.cwd, parsed.projectId) }
  }
  if (observed.agentRoot === undefined) {
    return {
      missingAgentPath:
        observed.searchedAgentRoots.join(', ') || `<unresolved agent home for ${parsed.agentId}>`,
    }
  }

  const projectRoot = observed.projectRoot
  // A project-bearing scope always launches at the checkout root. The input
  // cwd is only a discovery seed; preserving a nested cwd (or agent home) here
  // would split provider session storage from the project-scoped lineage.
  const cwd = projectRoot ?? observed.cwd ?? observed.agentRoot
  return {
    placement: {
      agentRoot: observed.agentRoot,
      ...(projectRoot === undefined ? {} : { projectRoot }),
      cwd,
      runMode: 'task',
      bundle: observed.bundle ?? {
        kind: 'agent-project',
        agentName: parsed.agentId,
        ...(projectRoot === undefined ? {} : { projectRoot }),
      },
      dryRun: false,
    },
    ...(observed.harness.effectiveHarness === undefined
      ? {}
      : { effectiveHarness: observed.harness.effectiveHarness }),
  }
}

async function resolvedPlacement(
  scopeRef: string,
  hint: SummonCapabilityHint | undefined,
  options: {
    env: Record<string, string | undefined>
    cwd: string
    registryProjects?: readonly WrkqProjectRegistryEntry[] | undefined
  }
): Promise<NodeLocalPlacementResolution> {
  if (hint?.placement !== undefined) {
    return {
      placement: hint.placement,
      ...(hint.harness?.id === undefined ? {} : { effectiveHarness: hint.harness.id }),
    }
  }
  return resolveNodeLocalPlacement(scopeRef, options)
}

/** Builds the observer injected into every configured summon gate. */
export function createSummonCapabilityObserver(
  options: SummonCapabilityObserverOptions = {}
): (
  scopeRef: string,
  hint?: SummonCapabilityHint | undefined
) => Promise<SummonCapabilityObservation> {
  const env = options.env ?? process.env
  const userHome = options.userHome ?? env['HOME'] ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const detectHarness = options.detectHarness

  return async (scopeRef, hint) => {
    let resolved: NodeLocalPlacementResolution
    try {
      resolved = await resolvedPlacement(scopeRef, hint, { env, cwd })
    } catch (error) {
      return incapable(
        'agent-home-skills',
        `agent home/skills could not be resolved for ${scopeRef}: ${error instanceof Error ? error.message : String(error)} — sync the agent source home on this node`
      )
    }

    if (resolved.unresolvableProjectPath !== undefined) {
      // An explicit override naming a missing checkout is a checkout fact
      // with a real path — not an unresolvable root. Name the clone/sync fix.
      const override = env['ASP_PROJECT_ROOT_OVERRIDE']
      if (override !== undefined && !isDirectory(override)) {
        return incapable(
          'project-checkout',
          `project checkout absent at ${override} — clone or sync the project checkout on this node`
        )
      }
      return incapable(
        'project-checkout',
        `project root could not be resolved from ${resolved.unresolvableProjectPath} — ensure the checkout has an asp-targets.toml or git root, or supply an explicit project placement`,
        'project-root-unresolvable'
      )
    }
    if (resolved.missingAgentPath !== undefined) {
      return incapable(
        'agent-home-skills',
        `agent home/skills absent at ${resolved.missingAgentPath} — sync the agent source home and its skills on this node`
      )
    }

    const placement = resolved.placement
    if (placement === undefined) {
      return incapable(
        'agent-home-skills',
        `agent home/skills could not be resolved for ${scopeRef} — sync the agent source home on this node`
      )
    }
    if (placement.projectRoot !== undefined && !isDirectory(placement.projectRoot)) {
      return incapable(
        'project-checkout',
        `project checkout absent at ${placement.projectRoot} — clone or sync the project checkout on this node`
      )
    }
    if (!isDirectory(placement.agentRoot)) {
      return incapable(
        'agent-home-skills',
        `agent home/skills absent at ${placement.agentRoot} — sync the agent source home and its skills on this node`
      )
    }

    const harnessId = adapterIdFor(hint, resolved.effectiveHarness)
    if (harnessId === undefined && resolved.effectiveHarness !== undefined) {
      return incapable(
        'harness',
        `harness unavailable for ${scopeRef}: observed harness "${resolved.effectiveHarness}" names no supported driver — configure and install a supported harness on this node`
      )
    }
    if (harnessId === undefined) {
      return incapable(
        'harness',
        `harness unavailable for ${scopeRef}: no supported harness is selected — configure and install a supported harness on this node`
      )
    }

    const credentials = credentialRefusal(harnessId, env, userHome)
    if (credentials !== undefined) return credentials

    const parsed = parseScopeRef(scopeRef)
    let detection: HarnessDetection
    try {
      detection = await (detectHarness !== undefined
        ? detectHarness(harnessId)
        : defaultDetectHarness(harnessId, {
            agentId: parsed.agentId,
            agentRoot: placement.agentRoot,
            ...(placement.projectRoot !== undefined ? { projectRoot: placement.projectRoot } : {}),
            ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
            cwd: placement.cwd ?? cwd,
          }))
    } catch (error) {
      detection = {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    if (!detection.available) {
      return incapable(
        'harness',
        `harness "${harnessId}" unavailable: ${detection.error ?? 'binary not found'} — install ${harnessId} on this node`
      )
    }

    return { outcome: 'capable' }
  }
}
