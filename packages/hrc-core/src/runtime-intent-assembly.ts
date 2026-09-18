/**
 * Single authority for deriving an {@link HrcRuntimeIntent} from OBSERVED ASP
 * declaration facts.
 *
 * T-08597: this module no longer parses agent profiles, project targets, or
 * the harness catalog in-process. The provider/harness/provisioning inputs
 * arrive already interpreted — either from the daemon's aspd-backed
 * `/v1/declarations/resolve` producer (over the socket) or from the same
 * observation in-process inside the daemon. HRC owns intent assembly,
 * interaction semantics, the directive grammar/deny-list, and every refusal.
 *
 * Before this module the harness→intent assembly was duplicated in hrcchat-cli,
 * hrc-cli, and agent-loop's dispatch adapter. This is the one place it lives now.
 */
import { DENIED_PROVISION_OVERRIDE_KEYS } from 'agent-scope'
import type { ProvisioningScalars } from 'agent-scope'
import type { HrcExecutionMode, HrcHarness, HrcRuntimeIntent } from './contracts.js'
import { HrcDomainError, HrcErrorCode } from './errors.js'
import type { HrcRuntimePlacement } from './placement-conventions.js'

export type ResolvedAgentHarness = {
  provider: 'anthropic' | 'openai' | 'meta'
  /** Frontend harness name from the observed provisioning (e.g. "codex-cli"). */
  harness: string | undefined
  /**
   * T-07398 — the observed `[provisioning]` top-level scalars behind that
   * harness choice, i.e. the BASELINE a per-summon directive block overrides.
   * Empty when nothing declares any.
   */
  provision: ProvisioningScalars
}

/**
 * HRC-admitted harness frontends. Observed frontends outside this set carry no
 * explicit id — HRC picks its default — exactly as the pre-migration
 * normalization did for catalog names without a frontend. (ASP may name
 * frontends HRC has not admitted yet; only HRC-known ids are forwarded.)
 */
const HRC_ADMITTED_HARNESS_FRONTENDS: ReadonlySet<string> = new Set<string>([
  'agent-sdk',
  'claude-code',
  'codex-cli',
  'pi-cli',
  'pi-sdk',
  'muse-cli',
])

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
 */
function scalarsOnly(scalars: Record<string, unknown>): ProvisioningScalars {
  return Object.fromEntries(
    Object.entries(scalars).filter(
      ([, value]) =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    )
  ) as ProvisioningScalars
}

/**
 * Normalize an OBSERVED harness frontend name to the canonical {@link HrcHarness}
 * id the dispatcher understands.
 *
 * T-08597 narrowing (explicit in the hrc-sdk surface diff): the input must
 * already be frontend form — declaration observations always are
 * (`entry.frontend`, projected aspd-side). Bare catalog ids/aliases
 * (`codex`, `pi`, `claude-code` alias, …) no longer normalize; they resolve to
 * `undefined` and HRC picks its default. Nothing in-repo passes id form; the
 * observation path never did.
 */
export function harnessFrontendToHrcHarness(harness: string | undefined): HrcHarness | undefined {
  if (harness === undefined) return undefined
  return HRC_ADMITTED_HARNESS_FRONTENDS.has(harness) ? (harness as HrcHarness) : undefined
}

export interface BuildHrcRuntimeIntentInput {
  /** Agent id — names the declaration the intent is assembled from. */
  agentId: string
  /** Resolved agent root (where `agent-profile.toml` lives). */
  agentRoot: string
  /** Resolved project root, if any. */
  projectRoot?: string | undefined
  /** Working directory for the runtime; defaults to projectRoot ?? agentRoot. */
  cwd?: string | undefined
  /** Placement run mode; defaults to 'task'. */
  runMode?: HrcRuntimePlacement['runMode'] | undefined
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
   * T-07398 — a per-summon provisioning directive block. hrc-sdk forwards it
   * to the daemon, which applies it aspd-side as the FINAL step of assembly.
   * Deny-listed keys never reach here (the sender grammar refuses them) and
   * are stripped again on the way out.
   */
  provision?: Partial<ProvisioningScalars> | undefined
  /** Test/operator seam; production discovers the installed daemon socket. */
  socketPath?: string | undefined
}

/**
 * Apply a per-summon directive block to observed provisioning — the FINAL step
 * of provisioning assembly.
 *
 * T-08597 compat narrowing (explicit in the hrc-sdk surface diff): the
 * provider follows the overlaid harness only when the directives leave the
 * harness unchanged (the common case — every in-repo caller forwards the block
 * to the daemon route instead, where aspd re-resolves provider and harness id
 * from the overlaid declaration). A directive block that CHANGES the harness
 * throws a typed error directing the caller to `POST /v1/declarations/resolve`:
 * mapping the new harness name to its provider is catalog interpretation,
 * which HRC no longer performs in-process.
 */
export function applyProvisionDirectives(
  merged: ResolvedAgentHarness,
  directives: Partial<ProvisioningScalars> | undefined
): {
  provision: ProvisioningScalars
  harness: string | undefined
  provider: 'anthropic' | 'openai' | 'meta'
  harnessId: HrcHarness | undefined
} {
  const provision = overridableProvision({
    ...merged.provision,
    ...scalarsOnly(directives ?? {}),
  })
  const harness = provision.harness ?? merged.harness
  if (harness !== undefined && harness !== merged.harness) {
    throw new HrcDomainError(
      HrcErrorCode.UNSUPPORTED_CAPABILITY,
      'provision directive changes the harness; resolve through POST /v1/declarations/resolve',
      { capability: 'intent.directive-harness-change', harness }
    )
  }
  return {
    provision,
    harness,
    provider: merged.provider,
    harnessId: harnessFrontendToHrcHarness(harness),
  }
}

/**
 * T-08564: the single-line `agent.provisioning.stripped` warning, shared by the
 * in-process assembler and the declaration-observation route, which projects it
 * from an explicit producer `invalid` profile observation. Only the `error=`
 * detail comes from the caller; every other byte is HRC-owned.
 */
export function formatProfileProvisioningStrippedWarning(input: {
  agentId: string
  profilePath: string
  errorMessage: string
  survivingProvisionKeys: readonly string[]
}): string {
  const survived = input.survivingProvisionKeys
  const consequence =
    survived.length === 0
      ? 'is being born with NO provisioning at all: no model pin, no harness pin, no yolo, no node'
      : `is being born WITHOUT its profile's provisioning (no model pin, no harness pin from the profile); only the project target's ${JSON.stringify(survived)} survives`
  const rendered = input.errorMessage.replace(/\s+/g, ' ').trim()
  const detail = rendered.length > 300 ? `${rendered.slice(0, 297)}...` : rendered
  return [
    `[hrc-core] WARN agent.provisioning.stripped — agent "${input.agentId}" ${consequence}.`,
    'Its agent-profile.toml EXISTS but could not be read or parsed, so it contributed nothing.',
    `profile=${input.profilePath} error=${detail}`,
  ].join(' ')
}

/**
 * T-08564 parity: the single-line `agent.provisioning.stripped` warning for an
 * invalid-but-present profile, built from observed diagnostics. The daemon
 * route projects it; kick-intent logs it — the same WARN the local assembler
 * printed, byte for byte.
 */
export function buildInvalidProfileWarning(input: {
  agentId: string
  agentRoot: string
  diagnosticMessages: readonly string[]
  survivingProvisionKeys: readonly string[]
}): string {
  return formatProfileProvisioningStrippedWarning({
    agentId: input.agentId,
    profilePath: `${input.agentRoot.replace(/\/+$/, '')}/agent-profile.toml`,
    errorMessage: input.diagnosticMessages.join(' '),
    survivingProvisionKeys: input.survivingProvisionKeys,
  })
}

export type ObservedRuntimeIntentProvisioning = {
  provider: 'anthropic' | 'openai' | 'meta'
  frontend: string
  effectiveHarness: string
  scalars: Record<string, string | number | boolean>
}

export type ObservedRuntimeIntentPlacement = {
  agentRoot: string
  projectRoot?: string | undefined
  cwd: string
  runMode: HrcRuntimePlacement['runMode']
  bundle: HrcRuntimePlacement['bundle']
}

/**
 * Assemble an {@link HrcRuntimeIntent} from an OBSERVED declaration (aspd
 * projection) plus the caller's interaction semantics. Pure and sync: the
 * daemon calls this in-process (no self-HTTP); hrc-sdk's async
 * `buildHrcRuntimeIntent` observes over the socket first, then assembles here.
 */
export function assembleHrcRuntimeIntent(
  observed: {
    provisioning: ObservedRuntimeIntentProvisioning
    placement: ObservedRuntimeIntentPlacement
  },
  body: {
    interactive?: boolean | undefined
    preferredMode?: HrcExecutionMode | undefined
    allowInteractiveSurfaceReuse?: boolean | undefined
    initialPrompt?: string | undefined
  }
): HrcRuntimeIntent {
  const interactive = body.interactive ?? false
  const preferredMode: HrcExecutionMode = body.preferredMode ?? 'nonInteractive'
  const provision = overridableProvision(
    scalarsOnly(observed.provisioning.scalars) as ProvisioningScalars
  )
  const harnessId = harnessFrontendToHrcHarness(observed.provisioning.frontend)

  const placement: HrcRuntimePlacement = {
    agentRoot: observed.placement.agentRoot,
    ...(observed.placement.projectRoot !== undefined
      ? { projectRoot: observed.placement.projectRoot }
      : {}),
    cwd: observed.placement.cwd,
    runMode: observed.placement.runMode,
    bundle: observed.placement.bundle,
    dryRun: false,
  }

  return {
    placement: placement as HrcRuntimeIntent['placement'],
    harness: {
      provider: observed.provisioning.provider,
      interactive,
      ...(harnessId !== undefined ? { id: harnessId } : {}),
    },
    execution: {
      preferredMode,
      ...(body.allowInteractiveSurfaceReuse !== undefined
        ? { allowInteractiveSurfaceReuse: body.allowInteractiveSurfaceReuse }
        : {}),
    },
    ...(body.initialPrompt !== undefined ? { initialPrompt: body.initialPrompt } : {}),
    ...(Object.keys(provision).length === 0 ? {} : { provision }),
  }
}
