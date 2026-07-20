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
  type HarnessDetection,
  type HarnessId,
  type ResolvedPlacementContext,
  type RuntimePlacement,
  buildRuntimeBundleRef,
  normalizeHarnessFrontend,
  resolveAgentPlacementPaths,
  resolvePlacementContext,
} from 'spaces-config'
import { harnessRegistry } from 'spaces-execution'

import type { SummonCapabilityHint, SummonCapabilityObservation } from './summon-gate.js'

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
  diagnostic: string
): SummonCapabilityObservation {
  return {
    outcome: 'incapable',
    capability,
    diagnostic,
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
  context: ResolvedPlacementContext
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
    }
  }

  const frontend = context.materialization.effectiveConfig?.harness
  const normalized = normalizeHarnessFrontend(frontend)
  switch (normalized) {
    case 'agent-sdk':
      return 'claude-agent-sdk'
    case 'claude-code':
      return 'claude'
    case 'codex-cli':
      return 'codex'
    case 'pi-cli':
      return 'pi'
    case 'pi-sdk':
      return 'pi-sdk'
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
  }
}

async function defaultDetectHarness(harnessId: HarnessId): Promise<HarnessDetection> {
  const adapter = harnessRegistry.get(harnessId)
  if (adapter === undefined) {
    return { available: false, error: `no registered adapter for ${harnessId}` }
  }
  return await adapter.detect()
}

function resolvedPlacement(
  scopeRef: string,
  hint: SummonCapabilityHint | undefined,
  options: { env: Record<string, string | undefined>; cwd: string }
): {
  placement?: RuntimePlacement
  missingProjectPath?: string
  missingAgentPath?: string
} {
  if (hint?.placement !== undefined) return { placement: hint.placement }

  const parsed = parseScopeRef(scopeRef)
  const paths = resolveAgentPlacementPaths({
    agentId: parsed.agentId,
    ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
    cwd: options.cwd,
    env: options.env,
  })

  if (parsed.projectId !== undefined && paths.projectRoot === undefined) {
    return {
      missingProjectPath:
        options.env['ASP_PROJECT_ROOT_OVERRIDE'] ?? `<unresolved checkout for ${parsed.projectId}>`,
    }
  }
  if (paths.agentRoot === undefined) {
    return {
      missingAgentPath:
        paths.searchedAgentRoots?.join(', ') ?? `<unresolved agent home for ${parsed.agentId}>`,
    }
  }

  const projectRoot = paths.projectRoot
  const cwd = paths.cwd ?? projectRoot ?? paths.agentRoot
  return {
    placement: {
      agentRoot: paths.agentRoot,
      ...(projectRoot === undefined ? {} : { projectRoot }),
      cwd,
      runMode: 'task',
      bundle: buildRuntimeBundleRef({
        agentName: parsed.agentId,
        agentRoot: paths.agentRoot,
        ...(projectRoot === undefined ? {} : { projectRoot }),
      }),
      dryRun: false,
    },
  }
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
  const detectHarness = options.detectHarness ?? defaultDetectHarness

  return async (scopeRef, hint) => {
    let resolved: ReturnType<typeof resolvedPlacement>
    try {
      resolved = resolvedPlacement(scopeRef, hint, { env, cwd })
    } catch (error) {
      return incapable(
        'agent-home-skills',
        `agent home/skills could not be resolved for ${scopeRef}: ${error instanceof Error ? error.message : String(error)} — sync the agent source home on this node`
      )
    }

    if (resolved.missingProjectPath !== undefined) {
      return incapable(
        'project-checkout',
        `project checkout absent at ${resolved.missingProjectPath} — clone or sync the project checkout on this node`
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

    let context: ResolvedPlacementContext
    try {
      context = await resolvePlacementContext({ ...placement, dryRun: false })
    } catch (error) {
      return incapable(
        'agent-home-skills',
        `agent home/skills at ${placement.agentRoot} cannot compose ${scopeRef}: ${error instanceof Error ? error.message : String(error)} — repair or sync the agent home and skills on this node`
      )
    }

    const harnessId = adapterIdFor(hint, context)
    if (harnessId === undefined) {
      return incapable(
        'harness',
        `harness unavailable for ${scopeRef}: no supported harness is selected — configure and install a supported harness on this node`
      )
    }

    const credentials = credentialRefusal(harnessId, env, userHome)
    if (credentials !== undefined) return credentials

    let detection: HarnessDetection
    try {
      detection = await detectHarness(harnessId)
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
