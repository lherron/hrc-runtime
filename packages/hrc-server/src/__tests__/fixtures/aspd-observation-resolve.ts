import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { resolveFixtureHarnessCatalogEntry } from './fixture-catalog.js'
import { type FixtureAgentProfile, readFixtureAgentProfile } from './fixture-profile.js'

import { agentName, agentSources, bundleRef, projectRoot } from './aspd-observation-context'
import type { AspdObservationOptions, ResolveScript } from './aspd-observation-types'

/** Copied from evidence/double-parity/real/resolve_ok.json `resolve_ok.reply.result`. */
function resolveOkResponse(
  context: Record<string, unknown>,
  identityRole?: string
): Record<string, unknown> {
  const root = projectRoot(context)
  const agentRoot = String(context['agentRoot'] ?? '/tmp/t08564-agent')
  const directives = (context['provisionDirectives'] ?? {}) as Record<string, unknown>
  const placement = {
    agentRoot,
    ...(root !== undefined ? { projectRoot: root } : {}),
    cwd: String(context['cwd'] ?? agentRoot),
    runMode: String(context['runMode'] ?? 'task'),
    bundle: bundleRef(context),
  }
  const baselineProvisioning = {
    scalars: {
      harness: 'claude-code',
      model: 'opus',
      yolo: true,
      remote: true,
    },
    declaredHarness: 'claude-code',
    effectiveHarness: 'claude',
    frontend: 'claude-code',
    provider: 'anthropic',
    family: 'claude',
    runtime: 'claude-code',
  }
  const provisioning = {
    ...baselineProvisioning,
    scalars: {
      ...baselineProvisioning.scalars,
      ...(directives['model'] !== undefined ? { model: directives['model'] } : {}),
    },
  }
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
    ok: true,
    evaluatedAt: '2026-09-16T00:00:00.000Z',
    contextHash: 'sha256:t08564-context',
    agentSources: agentSources(context),
    searchedAgentRoots: [],
    source: {
      agentProfile: {
        state: 'valid',
        code: 'parsed',
        contentHash: 'sha256:agent-profile',
        declaredHarness: 'claude-code',
        declaredProvider: 'anthropic',
      },
      projectTargets: { state: 'absent', code: 'not_declared' },
      selectedTarget: { state: 'absent', code: 'not_declared' },
      priming: {
        state: 'valid',
        code: 'parsed',
        contentHash: 'sha256:priming',
      },
    },
    identity: {
      operator: false,
      ...(identityRole !== undefined ? { role: identityRole } : {}),
    },
    policy: {
      claimsTask: false,
      placement: {
        pins: { 'hrc-runtime:hrcdev': 'hrcdev' },
        homes: { primary: 'max3', minisvc: 'svc', minilab: 'lab' },
      },
    },
    baselineProvisioning,
    provisioning,
    priming: {
      content: 'You are {{agentId}} in {{projectId}} working on {{taskId}}.',
      source: 'inline',
    },
    placement,
    bundle: { ref: placement.bundle, identity: 'bundle:t08564' },
    diagnostics: [],
  }
}

/** Copied from evidence/double-parity/real/resolve_absent.json `resolve_absent.reply.result`. */
function resolveAbsentResponse(context: Record<string, unknown>): Record<string, unknown> {
  const roots = (context['agentSources'] ?? {}) as Record<string, unknown>
  const root = typeof roots['agentsRoot'] === 'string' ? roots['agentsRoot'] : '/tmp/t08564-agents'
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
    ok: false,
    agentSources: agentSources(context),
    searchedAgentRoots: [`${root}/${agentName(context)}`],
    source: {
      agentProfile: { state: 'absent', code: 'not_declared' },
      projectTargets: { state: 'absent', code: 'not_declared' },
      selectedTarget: { state: 'absent', code: 'not_declared' },
      priming: { state: 'absent', code: 'not_declared' },
    },
    resolution: {
      state: 'absent',
      code: 'agent_not_found',
      message: `Agent ${agentName(context)} was not found`,
      diagnostics: [],
    },
  }
}

/** Copied from evidence/double-parity/real/resolve_invalid.json `resolve_invalid.reply.result`. */
function resolveInvalidResponse(context: Record<string, unknown>): Record<string, unknown> {
  const diagnostic = {
    severity: 'error',
    code: 'project_targets_invalid',
    message: 'fixture targets parse failed',
    source: 'project-targets',
  }
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
    ok: false,
    agentSources: agentSources(context),
    searchedAgentRoots: [],
    source: {
      agentProfile: {
        state: 'valid',
        code: 'parsed',
        contentHash: 'sha256:agent-profile',
      },
      projectTargets: { state: 'invalid', diagnostics: [diagnostic] },
      selectedTarget: { state: 'absent', code: 'not_declared' },
      priming: { state: 'absent', code: 'not_declared' },
    },
    resolution: {
      state: 'invalid',
      code: 'project_targets_invalid',
      message: 'fixture targets parse failed',
      diagnostics: [diagnostic],
    },
  }
}

/** Copied from evidence/double-parity/real/resolve_incompatible.json. */
function resolveIncompatibleResponse(): Record<string, unknown> {
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
    ok: false,
    failure: {
      kind: 'incompatible',
      code: 'configured_context_mismatch',
      message: 'Configured path is not a directory: /tmp/t08564-notafile',
    },
  }
}

/**
 * Copied from T-08564 evidence/double-parity-3/real/resolve_caller_root_nonexistent.json
 * (live asp-aafe904ce28c-20260917T083116Z-355af1): a caller-supplied agent root
 * that does not exist is refused as a context mismatch before any declaration
 * is read.
 */
function resolveNonexistentCallerRootResponse(
  context: Record<string, unknown>
): Record<string, unknown> {
  const agentRoot = String(context['agentRoot'] ?? '/tmp/t08564-agent')
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
    ok: false,
    failure: {
      kind: 'incompatible',
      code: 'configured_context_mismatch',
      message: `ENOENT: no such file or directory, stat '${agentRoot}'`,
    },
  }
}

/**
 * Copied from evidence/double-parity/live-invalid-profile/schema-invalid-profile.json
 * `resolve_schema_invalid_profile_with_target.reply.result`.
 */
function resolveAgentProfileInvalidLiveResponse(
  context: Record<string, unknown>
): Record<string, unknown> {
  const diagnostic = {
    severity: 'error',
    code: 'agent_profile_invalid',
    message: 'Invalid agent-profile.toml: unknown property',
    source: 'agent-profile',
  }
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
    ok: false,
    agentSources: agentSources(context),
    searchedAgentRoots: [],
    source: {
      agentProfile: { state: 'absent', code: 'not_declared' },
      projectTargets: { state: 'absent', code: 'not_declared' },
      selectedTarget: { state: 'absent', code: 'not_declared' },
      priming: { state: 'absent', code: 'not_declared' },
    },
    resolution: {
      state: 'invalid',
      code: 'agent_profile_invalid',
      message: diagnostic.message,
      diagnostics: [diagnostic],
    },
  }
}

/** The degraded ok arm's profile diagnostic, as captured on asp-aafe904ce28c-20260917T083116Z-355af1. */
function invalidProfileDiagnostic(agentRoot: string): Record<string, unknown> {
  return {
    severity: 'error',
    code: 'agent_profile_invalid',
    message:
      'Failed to parse TOML: Unexpected character, expected whitespace, . or ] at row 2, col 14, pos 26:\n1: version = 3\n2> [provisioning\n                ^\n3: harness = \n\n',
    source: 'agent-profile',
    path: `${agentRoot}/agent-profile.toml`,
  }
}

/** Live-captured ok-arm envelope around a caller-supplied source and provisioning. */
function capturedDegradedResponse(
  context: Record<string, unknown>,
  source: Record<string, unknown>,
  provisioning: Record<string, unknown>,
  diagnostics: Record<string, unknown>[]
): Record<string, unknown> {
  const root = projectRoot(context)
  const agentRoot = String(context['agentRoot'] ?? '/tmp/t08564-agent')
  const bundle = {
    kind: 'agent-project',
    agentName: String(context['agentId'] ?? 'smokey'),
    ...(root !== undefined ? { projectRoot: root } : {}),
  }
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
    ok: true,
    evaluatedAt: '2026-09-17T08:32:07.600Z',
    contextHash: '0d7c7b9d9373f50bc04f53d8f701663a76b5711728b85d46c74c9bd759d8f444',
    agentSources: agentSources(context),
    searchedAgentRoots: [],
    source,
    identity: { operator: false },
    policy: { claimsTask: false, placement: { pins: {}, homes: {} } },
    baselineProvisioning: provisioning,
    provisioning,
    placement: {
      agentRoot,
      ...(root !== undefined ? { projectRoot: root } : {}),
      cwd: String(context['cwd'] ?? agentRoot),
      runMode: String(context['runMode'] ?? 'task'),
      bundle,
    },
    bundle: {
      ref: bundle,
      identity: '49a9c5abbb5def6b2f141771c55dde44517ed4fbda468140ef1ac7a1bb9eef78',
    },
    diagnostics,
  }
}

/**
 * Copied from T-08564 evidence/double-parity-3/real/resolve_invalid_profile_target_root.json
 * (live asp-aafe904ce28c-20260917T083116Z-355af1): case (h), a malformed profile with a valid
 * selected target. Scalars are exactly the target's declared keys; there is no
 * declaredHarness. A caller `model` directive overlays the captured scalar.
 */
function resolveInvalidProfileTargetOnlyResponse(
  context: Record<string, unknown>
): Record<string, unknown> {
  const agentRoot = String(context['agentRoot'] ?? '/tmp/t08564-agent')
  const diagnostic = invalidProfileDiagnostic(agentRoot)
  const directives = (context['provisionDirectives'] ?? {}) as Record<string, unknown>
  return capturedDegradedResponse(
    context,
    {
      agentProfile: { state: 'invalid', diagnostics: [diagnostic] },
      projectTargets: {
        state: 'valid',
        code: 'parsed',
        contentHash: '4dbdf3f42104cc30ca00b2c7ec8eb33640d494fa76fa91214ca492080fe5f9f0',
      },
      selectedTarget: {
        state: 'valid',
        code: 'parsed',
        contentHash: '2f6f4dbd10393a6e8db6d154d3d09933644dd58c97ef6591d4757857c5566744',
      },
      priming: { state: 'absent', code: 'not_declared' },
    },
    {
      scalars: {
        harness: 'codex',
        model: directives['model'] ?? 'gpt-5.6-terra',
      },
      effectiveHarness: 'codex',
      frontend: 'codex-cli',
      provider: 'openai',
      family: 'codex',
      runtime: 'codex-cli',
    },
    [diagnostic]
  )
}

/**
 * Copied from T-08564 evidence/double-parity-3/real/resolve_invalid_profile_mode_none.json
 * and resolve_invalid_profile_root_no_selected_target.json (live
 * asp-aafe904ce28c-20260917T083116Z-355af1): a malformed profile with no valid target. Scalars
 * are {}, there is no harness key and no declaredHarness, provider anthropic.
 * Projectless observes targets absent; a root without this agent's target
 * observes the targets file valid and the selected target absent.
 */
function resolveInvalidProfileNoTargetResponse(
  context: Record<string, unknown>
): Record<string, unknown> {
  const agentRoot = String(context['agentRoot'] ?? '/tmp/t08564-agent')
  const diagnostic = invalidProfileDiagnostic(agentRoot)
  const projectless = projectRoot(context) === undefined
  return capturedDegradedResponse(
    context,
    {
      agentProfile: { state: 'invalid', diagnostics: [diagnostic] },
      projectTargets: projectless
        ? { state: 'absent', code: 'not_declared' }
        : {
            state: 'valid',
            code: 'parsed',
            contentHash: '76967903720684f8890854249faae9fc081ffb8bcc913acf2d71b88f78cc3b49',
          },
      selectedTarget: { state: 'absent', code: 'not_declared' },
      priming: { state: 'absent', code: 'not_declared' },
    },
    {
      scalars: {},
      effectiveHarness: 'claude',
      frontend: 'claude-code',
      provider: 'anthropic',
      family: 'claude',
      runtime: 'claude-code',
    },
    [diagnostic]
  )
}

/**
 * Copied from T-08564 evidence/double-parity-3/real/resolve_caller_root_without_profile.json
 * (live asp-aafe904ce28c-20260917T083116Z-355af1): a caller-supplied agent root that exists but
 * holds no agent-profile.toml is an ok arm with the profile absent, not
 * `agent_not_found` (T-08563 rev 5: a supplied root is read directly).
 */
function resolveAbsentProfileCallerRootResponse(
  context: Record<string, unknown>
): Record<string, unknown> {
  const absent = { state: 'absent', code: 'not_declared' }
  return capturedDegradedResponse(
    context,
    {
      agentProfile: absent,
      projectTargets: absent,
      selectedTarget: absent,
      priming: absent,
    },
    {
      scalars: { yolo: false, remote: false },
      effectiveHarness: 'claude',
      frontend: 'claude-code',
      provider: 'anthropic',
      family: 'claude',
      runtime: 'claude-code',
    },
    []
  )
}

const REAL_AGENTS_ROOT = '/Users/lherron/praesidium/var/agents'

type FixtureAgentHit = {
  agentRoot: string
  role?: string | undefined
  harnessProvider?: string | undefined
  harnessFrontend?: string | undefined
  harnessId?: string | undefined
  declaredHarness?: string | undefined
  claimsTask: boolean
  provisioningNode?: string | undefined
  pins: Record<string, string>
  homes: Record<string, string>
  profileInvalid: boolean
  profileAbsent: boolean
}

type ParsedFixtureProfile = FixtureAgentProfile

function readFixtureProfile(profilePath: string): ParsedFixtureProfile {
  return readFixtureAgentProfile(profilePath)
}

function lookupFixtureAgent(
  agentId: string,
  roots: string[]
):
  | FixtureAgentHit
  | { invalid: true; agentRoot: string }
  | { absentProfile: true; agentRoot: string }
  | undefined {
  for (const root of [...roots, REAL_AGENTS_ROOT]) {
    const home = join(root, agentId)
    const profilePath = join(home, 'agent-profile.toml')
    if (!existsSync(home)) continue
    if (!existsSync(profilePath)) return { absentProfile: true, agentRoot: home }
    let profile: ParsedFixtureProfile
    try {
      profile = readFixtureProfile(profilePath)
    } catch {
      return { invalid: true, agentRoot: home }
    }
    const declared = profile.provisioning?.['harness']
    const entry =
      (typeof declared === 'string' ? resolveFixtureHarnessCatalogEntry(declared) : undefined) ??
      undefined
    const role = profile.identity?.role
    const pins =
      profile.placement?.pins !== undefined && typeof profile.placement.pins === 'object'
        ? (profile.placement.pins as Record<string, string>)
        : {}
    const homes =
      profile.placement?.homes !== undefined && typeof profile.placement.homes === 'object'
        ? (profile.placement.homes as Record<string, string>)
        : {}
    const node = profile.provisioning?.['node']
    return {
      agentRoot: home,
      ...(typeof role === 'string' ? { role } : {}),
      ...(entry !== undefined
        ? {
            harnessProvider: entry.provider,
            harnessFrontend: entry.frontend,
            harnessId: entry.id,
            ...(typeof declared === 'string' ? { declaredHarness: declared } : {}),
          }
        : {}),
      claimsTask: profile.claims_task === true,
      ...(typeof node === 'string' ? { provisioningNode: node } : {}),
      pins,
      homes,
      profileInvalid: false,
      profileAbsent: false,
    }
  }
  return undefined
}

function resolveFixtureResponse(
  context: Record<string, unknown>,
  hit: FixtureAgentHit,
  identityRole?: string
): Record<string, unknown> {
  const out = resolveOkResponse(
    { ...context, agentRoot: hit.agentRoot },
    hit.role ?? identityRole
  ) as Record<string, unknown> & {
    provisioning: Record<string, unknown> & {
      scalars: Record<string, unknown>
    }
    source: Record<string, Record<string, unknown>>
    policy: Record<string, unknown>
  }
  // Project the profile's real placement policy (mirrors ASP provisioning():
  // claims_task, provisioning.node, placement pins/homes) instead of the
  // canned baseline, so pin/default-home tests read fixture declarations.
  out['policy'] = {
    claimsTask: hit.claimsTask,
    ...(hit.provisioningNode !== undefined ? { provisioningNode: hit.provisioningNode } : {}),
    placement: { pins: { ...hit.pins }, homes: { ...hit.homes } },
  }
  if (hit.harnessId !== undefined) {
    const provisioning = out.provisioning
    provisioning['effectiveHarness'] = hit.harnessId
    provisioning['frontend'] = hit.harnessFrontend
    provisioning['provider'] = hit.harnessProvider
    const scalars = provisioning['scalars']
    if (hit.declaredHarness !== undefined) {
      scalars['harness'] = hit.declaredHarness
      provisioning['declaredHarness'] = hit.declaredHarness
    }
    const source = out.source
    source['agentProfile'] = {
      state: 'valid',
      code: 'parsed',
      contentHash: 'sha256:agent-profile',
      ...(hit.declaredHarness !== undefined ? { declaredHarness: hit.declaredHarness } : {}),
      ...(hit.harnessProvider !== undefined ? { declaredProvider: hit.harnessProvider } : {}),
    }
  }
  return out
}

function resolveResponse(
  context: Record<string, unknown>,
  script: ResolveScript,
  identityRole?: string
): Record<string, unknown> {
  if (script === 'ok') return resolveOkResponse(context, identityRole)
  if (script === 'absent') return resolveAbsentResponse(context)
  if (script === 'invalid') return resolveInvalidResponse(context)
  if (script === 'agent-profile-invalid-live') {
    return resolveAgentProfileInvalidLiveResponse(context)
  }
  return resolveIncompatibleResponse()
}

export function resolveDeclarationResult(
  context: Record<string, unknown>,
  options: AspdObservationOptions
): Record<string, unknown> {
  if (options.agentRoot !== undefined && typeof context['agentRoot'] !== 'string') {
    context['agentRoot'] = options.agentRoot
  }
  const agentName = String(context['agentId'] ?? '')
  const fixtureHit =
    options.agentsRoots !== undefined &&
    typeof context['agentRoot'] !== 'string' &&
    agentName.length > 0
      ? lookupFixtureAgent(agentName, options.agentsRoots)
      : undefined
  if (fixtureHit !== undefined && 'pins' in fixtureHit) {
    return resolveFixtureResponse(context, fixtureHit, options.identityRole)
  }
  if (fixtureHit !== undefined && 'invalid' in fixtureHit) {
    return resolveInvalidProfileTargetOnlyResponse({
      ...context,
      agentRoot: fixtureHit.agentRoot,
    })
  }
  if (fixtureHit !== undefined && 'absentProfile' in fixtureHit) {
    return resolveAbsentProfileCallerRootResponse({
      ...context,
      agentRoot: fixtureHit.agentRoot,
    })
  }
  if (
    options.agentsRoots !== undefined &&
    typeof context['agentRoot'] !== 'string' &&
    agentName.length > 0
  ) {
    return resolveAbsentResponse(context)
  }
  if (options.nonexistentAgentRoot === true) return resolveNonexistentCallerRootResponse(context)
  if (options.absentAgentProfile === true) return resolveAbsentProfileCallerRootResponse(context)
  if (options.invalidAgentProfileNoTarget === true)
    return resolveInvalidProfileNoTargetResponse(context)
  if (options.invalidAgentProfile === true) return resolveInvalidProfileTargetOnlyResponse(context)
  return resolveResponse(context, options.resolve ?? 'ok', options.identityRole)
}
