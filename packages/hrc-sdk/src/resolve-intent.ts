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

import { DENIED_PROVISION_OVERRIDE_KEYS } from 'agent-scope'
import type { ProvisioningScalars } from 'agent-scope'
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
  /**
   * T-07398 — the merged `[provisioning]` top-level scalars behind that harness
   * choice: the agent profile overlaid with any matching project target, i.e.
   * the BASELINE a per-summon directive block overrides. Empty when no profile
   * (or project target) declares any.
   */
  provision: ProvisioningScalars
}

/**
 * The birth-time scalars that may ride an intent.
 *
 * Deliberately NOT the whole merged `[provisioning]` table: the deny-listed
 * keys are profile-only authority, so publishing them on the wire would put a
 * value on every intent that the server's dispatch boundary must then refuse.
 * The profile still decides them — they simply never travel as a directive.
 */
function overridableProvision(scalars: ProvisioningScalars): ProvisioningScalars {
  const carried: ProvisioningScalars = { ...scalars }
  for (const denied of DENIED_PROVISION_OVERRIDE_KEYS) {
    delete carried[denied]
  }
  return carried
}

/**
 * Keep only the members that can legally ride an intent: present, top-level
 * scalars.
 *
 * Two jobs, both structural rather than key-listed, which is what lets a future
 * `[provisioning]` scalar work here with no edit:
 *
 *  - absent keys are dropped, so an overlay never overwrites a merged value
 *    with `undefined` (`{ ...baseline, ...directives }` would otherwise let an
 *    explicitly-undefined member erase what the profile concluded);
 *  - non-scalars are dropped, because the profile-only harness escape hatches
 *    (`[provisioning.claude]`, `[provisioning.codex]`) share this table's shape
 *    and would otherwise be published on the wire — where the server's dispatch
 *    boundary refuses them as INVALID_PROVISION_SHAPE, turning a legitimate
 *    profile into an unstartable one.
 */
function scalarsOnly(scalars: Record<string, unknown>): ProvisioningScalars {
  return Object.fromEntries(
    Object.entries(scalars).filter(
      ([, value]) =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    )
  ) as ProvisioningScalars
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

function targetHarness(target: TargetDefinition | undefined): string | undefined {
  return (target as unknown as { provisioning?: { harness?: string } } | undefined)?.provisioning
    ?.harness
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
  const targetOnly = (): ResolvedAgentHarness => {
    const harness = targetHarness(projectTarget)
    return {
      provider: resolveProviderForHarness(harness),
      harness,
      provision: scalarsOnly({
        ...(projectTarget?.provisioning ?? {}),
        ...(harness === undefined ? {} : { harness }),
      }),
    }
  }
  if (!existsSync(profilePath)) {
    return targetOnly()
  }
  try {
    const source = readFileSync(profilePath, 'utf8')
    const profile = parseAgentProfile(source, profilePath)
    const primingPrompt = resolveAgentPrimingPrompt(profile, agentRoot)
    const effective = mergeAgentWithProjectTarget(
      {
        ...profile,
        ...(primingPrompt !== undefined ? { priming: primingPrompt } : {}),
      },
      projectTarget,
      'task'
    )
    // `node` is the one top-level scalar the merge does not project (it is
    // placement policy, not a harness setting), so take it from the same two
    // sources in the same order the merge uses.
    const node = projectTarget?.provisioning?.node ?? profile.provisioning?.node
    return {
      provider: resolveProviderForHarness(effective.harness),
      harness: effective.harness,
      provision: scalarsOnly({
        harness: effective.harness,
        model: effective.model,
        reasoning: effective.reasoning,
        approval: effective.approval,
        sandbox: effective.sandbox,
        yolo: effective.yolo,
        remote: effective.remoteControl,
        node,
      }),
    }
  } catch {
    return targetOnly()
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
  /**
   * T-05177: pass `false` for an autonomous one-shot that must never be deferred
   * into a live interactive broker surface for the same scope. Omitted ⇒ HRC's
   * default reuse behavior (treated as `true`).
   */
  allowInteractiveSurfaceReuse?: boolean | undefined
  /** Optional initial prompt threaded onto the intent. */
  initialPrompt?: string | undefined
  /**
   * T-07398 — a per-summon provisioning directive block, applied as the FINAL
   * step of assembly: it overlays whatever the profile+target merge concluded,
   * and the harness id and provider follow the OVERLAID harness rather than the
   * profile's. Deny-listed keys never reach here (the sender grammar refuses
   * them) and are stripped again on the way out.
   */
  provision?: Partial<ProvisioningScalars> | undefined
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
  const merged = resolveAgentHarness({ agentRoot, agentId, projectRoot })

  // The overlay is LAST, after the profile+target merge, so a directive can
  // change what the merge concluded. Everything downstream reads the overlaid
  // result — including the provider and harness id, which is why `harness=`
  // works at all: they are re-resolved here rather than carried over.
  const provision = overridableProvision({
    ...merged.provision,
    ...scalarsOnly(input.provision ?? {}),
  })
  const harness = provision.harness ?? merged.harness
  const provider = resolveProviderForHarness(harness)
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
    execution: {
      preferredMode,
      ...(input.allowInteractiveSurfaceReuse !== undefined
        ? { allowInteractiveSurfaceReuse: input.allowInteractiveSurfaceReuse }
        : {}),
    },
    ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
    // An agent with no declared `[provisioning]` and no directives carries no
    // block at all, rather than an empty one nobody can distinguish from "the
    // sender meant to say nothing".
    ...(Object.keys(provision).length === 0 ? {} : { provision }),
  }
}
