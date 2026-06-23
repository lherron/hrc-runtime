/**
 * Single authority for deriving an {@link HrcRuntimeIntent} from a resolved
 * agent placement.
 *
 * The harness/provider for a target is determined ENTIRELY by the agent profile
 * (and any project-target overlay), resolved through the canonical `spaces-config`
 * helpers. Callers (hrcchat, hrc-cli, agent-loop's hrc dispatch backend) supply
 * already-resolved placement paths plus their own turn semantics
 * (`interactive` / `preferredMode`) — they do NOT carry any concept of
 * "claude-code" vs "codex". That knowledge lives here, keyed off the profile.
 *
 * Before this module the harness→intent assembly was duplicated in hrcchat-cli,
 * hrc-cli, and agent-loop's dispatch adapter (each with its own bespoke,
 * sometimes-hardcoded provider). This is the one place it lives now.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { HrcExecutionMode, HrcHarness, HrcRuntimeIntent } from 'hrc-core'
import {
  type RuntimePlacement,
  type TargetDefinition,
  buildRuntimeBundleRef,
  mergeAgentWithProjectTarget,
  normalizeHarnessFrontend,
  parseAgentProfile,
  parseTargetsToml,
  resolveAgentPrimingPrompt,
  resolveHarnessProvider,
} from 'spaces-config'

export type ResolvedAgentHarness = {
  provider: 'anthropic' | 'openai'
  /** Frontend harness name from the profile/target (e.g. "claude-code", "codex"). */
  harness: string | undefined
}

function resolveProviderForHarness(harness: string | undefined): 'anthropic' | 'openai' {
  return resolveHarnessProvider(harness) ?? 'anthropic'
}

function loadProjectTarget(
  projectRoot: string | undefined,
  targetName: string
): TargetDefinition | undefined {
  if (!projectRoot) return undefined
  const targetsPath = join(projectRoot, 'asp-targets.toml')
  if (!existsSync(targetsPath)) return undefined
  return parseTargetsToml(readFileSync(targetsPath, 'utf8'), targetsPath).targets[targetName]
}

/**
 * Resolve the effective provider + harness frontend for an agent from its
 * `agent-profile.toml`, overlaid with any matching `asp-targets.toml` entry.
 * Falls back to the project-target harness (or anthropic) when no profile is
 * present or parsing fails — mirrors the prior hrcchat-cli behavior verbatim.
 */
export function resolveAgentHarness(args: {
  agentRoot: string
  agentId: string
  projectRoot?: string | undefined
}): ResolvedAgentHarness {
  const { agentRoot, agentId, projectRoot } = args
  const projectTarget = loadProjectTarget(projectRoot, agentId)
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return {
      provider: resolveProviderForHarness(projectTarget?.harness),
      harness: projectTarget?.harness,
    }
  }
  try {
    const source = readFileSync(profilePath, 'utf8').replace(
      /^(\s*)schema_version(\s*=)/m,
      '$1schemaVersion$2'
    )
    const profile = parseAgentProfile(source, profilePath)
    const primingPrompt = resolveAgentPrimingPrompt(profile, agentRoot)
    const effective = mergeAgentWithProjectTarget(
      {
        ...profile,
        ...(primingPrompt !== undefined ? { priming_prompt: primingPrompt } : {}),
      },
      projectTarget,
      'task'
    )
    return {
      provider: resolveProviderForHarness(effective.harness),
      harness: effective.harness,
    }
  } catch {
    return {
      provider: resolveProviderForHarness(projectTarget?.harness),
      harness: projectTarget?.harness,
    }
  }
}

/**
 * Normalize a harness frontend name from the profile (e.g. "pi-sdk", "agent-sdk",
 * "claude-code") to the canonical {@link HrcHarness} id the dispatcher understands.
 */
export function harnessFrontendToHrcHarness(harness: string | undefined): HrcHarness | undefined {
  return normalizeHarnessFrontend(harness) as HrcHarness | undefined
}

export interface BuildHrcRuntimeIntentInput {
  /** Agent id — used to match a project-target overlay for harness resolution. */
  agentId: string
  /** Resolved agent root (where `agent-profile.toml` lives). */
  agentRoot: string
  /** Resolved project root, if any. */
  projectRoot?: string | undefined
  /** Working directory for the runtime; defaults to projectRoot ?? agentRoot. */
  cwd?: string | undefined
  /** Placement run mode; defaults to 'task'. */
  runMode?: RuntimePlacement['runMode'] | undefined
  /** Caller's turn semantic — whether this is an interactive runtime. */
  interactive?: boolean | undefined
  /** Caller's preferred execution mode (its own turn semantic, not harness knowledge). */
  preferredMode?: HrcExecutionMode | undefined
  /** Optional initial prompt threaded onto the intent. */
  initialPrompt?: string | undefined
}

/**
 * Assemble an {@link HrcRuntimeIntent} from a resolved placement. The provider
 * and harness id are derived from the agent profile; the placement and the
 * caller-supplied interaction semantics are passed through unchanged.
 */
export function buildHrcRuntimeIntent(input: BuildHrcRuntimeIntentInput): HrcRuntimeIntent {
  const { agentId, agentRoot, projectRoot } = input
  const cwd = input.cwd ?? projectRoot ?? agentRoot
  const runMode = input.runMode ?? 'task'
  const interactive = input.interactive ?? false
  const preferredMode: HrcExecutionMode = input.preferredMode ?? 'nonInteractive'

  const bundle = buildRuntimeBundleRef({ agentName: agentId, agentRoot, projectRoot })
  const { provider, harness } = resolveAgentHarness({ agentRoot, agentId, projectRoot })
  const harnessId = harnessFrontendToHrcHarness(harness)

  const placement: RuntimePlacement = {
    agentRoot,
    ...(projectRoot ? { projectRoot } : {}),
    cwd,
    runMode,
    bundle,
    dryRun: false,
  }

  return {
    placement,
    harness: {
      provider,
      interactive,
      ...(harnessId !== undefined ? { id: harnessId } : {}),
    },
    execution: { preferredMode },
    ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
  }
}
