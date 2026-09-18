/**
 * PROVISIONAL — shapes transcribed from T-08563 rev 5; not graded for producer
 * parity until compared with a real T-08563 producer call.
 *
 * Unix-socket NDJSON JSON-RPC double for T-08564's declaration and preview
 * observations. Keep the request ledger behavioral: the route tests use it to
 * prove project-mode/context forwarding and the single-connection preview law.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { HarnessInvocationSpec, InvocationStartRequest } from 'spaces-harness-broker-protocol'
import {
  type RuntimeIdentityAllocation,
  neutralSpecHash,
  neutralStartRequestHash,
} from 'spaces-runtime-contracts'

import type { Release } from './aspd-route-doubles'
import { resolveFixtureHarnessCatalogEntry } from './fixture-catalog.js'
import { type FixtureAgentProfile, readFixtureAgentProfile } from './fixture-profile.js'

export type ResolveScript =
  | 'ok'
  | 'absent'
  | 'invalid'
  | 'incompatible'
  | 'agent-profile-invalid-live'
export type PromptScript = 'present' | 'absent' | 'invalid'

export type AspdObservationOptions = {
  /**
   * Fixture agent home: when the declaration context carries no caller
   * agentRoot, resolve the agent here instead of the canned default. Lets
   * kicker/summon tests birth fixture agents (homes invisible to a real
   * aspd) while keeping every other fact canned per script.
   */
  agentRoot?: string
  /**
   * Fixture agents roots searched in order (real homes appended
   * automatically): a profile hit resolves with the REAL agent home, a total
   * miss answers agent_not_found. Lets negative tests (unknown agents) keep
   * failing while fixture agents birth.
   */
  agentsRoots?: string[]
  resolve?: ResolveScript
  prompt?: PromptScript
  inspectNonOk?: boolean
  identityRole?: string
  invalidAgentProfile?: boolean
  invalidAgentProfileNoTarget?: boolean
  absentAgentProfile?: boolean
  nonexistentAgentRoot?: boolean
  protocolVersion?: string
  capabilities?: Partial<{
    resolveRuntimeDeclaration: boolean
    inspectRuntimePlacement: boolean
    compileHarnessInvocation: boolean
    inspectRuntimePlacementPreparationCorrelation: boolean
  }>
  socketAbsent?: boolean
}

export type ObservationRequest = {
  method: string
  params: Record<string, unknown>
}

export type ObservationConnection = {
  methods: string[]
  requests: ObservationRequest[]
}

export type AspdObservationDouble = {
  serving: Release
  connections: ObservationConnection[]
  openConnections: number
  stop(): void
}

function agentSources(context: Record<string, unknown>) {
  const supplied = (context['agentSources'] ?? {}) as Record<string, unknown>
  return {
    aspHome: supplied['aspHome'] ?? '/Users/lherron/praesidium/var/spaces-repo',
    agentsRoot: supplied['agentsRoot'] ?? '/Users/lherron/praesidium/var/agents',
    provenance: typeof context['agentRoot'] === 'string' ? 'caller-agent-root' : 'caller',
  }
}

function agentName(context: Record<string, unknown>): string {
  return String(context['agentId'] ?? 'probe')
}

function projectRoot(context: Record<string, unknown>): string | undefined {
  const project = (context['project'] ?? { mode: 'none' }) as Record<string, unknown>
  return project['mode'] === 'root' && typeof project['projectRoot'] === 'string'
    ? project['projectRoot']
    : undefined
}

function bundleRef(context: Record<string, unknown>) {
  const root = projectRoot(context)
  return {
    kind: 'agent-project',
    agentName: agentName(context),
    ...(root !== undefined ? { projectRoot: root } : {}),
  }
}

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
      priming: { state: 'valid', code: 'parsed', contentHash: 'sha256:priming' },
    },
    identity: { operator: false, ...(identityRole !== undefined ? { role: identityRole } : {}) },
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
      agentProfile: { state: 'valid', code: 'parsed', contentHash: 'sha256:agent-profile' },
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
    { agentProfile: absent, projectTargets: absent, selectedTarget: absent, priming: absent },
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
    provisioning: Record<string, unknown> & { scalars: Record<string, unknown> }
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

/** Copied from evidence/double-parity/real/inspect_present.json `declaration`. */
function inspectDeclaration(context: Record<string, unknown>): Record<string, unknown> {
  const root = projectRoot(context)
  const agentRoot = String(context['agentRoot'] ?? '/tmp/t08564-agent')
  const placement = {
    agentRoot,
    ...(root !== undefined ? { projectRoot: root } : {}),
    cwd: String(context['cwd'] ?? agentRoot),
    runMode: String(context['runMode'] ?? 'task'),
    bundle: bundleRef(context),
  }
  const provisioning = {
    scalars: { yolo: false, remote: false },
    effectiveHarness: 'claude',
    frontend: 'claude-code',
    provider: 'anthropic',
    family: 'claude',
    runtime: 'claude-code',
  }
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
    ok: true,
    evaluatedAt: '2026-09-17T07:46:06.313Z',
    contextHash: 'sha256:t08564-inspection-context',
    agentSources: agentSources(context),
    searchedAgentRoots: [],
    source: {
      agentProfile: { state: 'valid', code: 'parsed', contentHash: 'sha256:agent-profile' },
      projectTargets: { state: 'absent', code: 'not_declared' },
      selectedTarget: { state: 'absent', code: 'not_declared' },
      priming: { state: 'absent', code: 'not_declared' },
    },
    identity: { operator: false },
    policy: { claimsTask: false, placement: { pins: {}, homes: {} } },
    baselineProvisioning: provisioning,
    provisioning,
    placement,
    bundle: { ref: placement.bundle, identity: 'bundle:t08564-inspection' },
    diagnostics: [],
  }
}

/** Copied from evidence/double-parity/real/inspect_present.json `inspection`. */
function inspectionResult(context: Record<string, unknown>): Record<string, unknown> {
  const name = agentName(context)
  const effective = { kind: 'effective' }
  const contribution = {
    contributions: [
      { kind: 'runtime-plan', sourceId: 'canonical-compile', sourceRef: 'agent-runtime-plan/v1' },
    ],
  }
  return {
    schemaVersion: 'agent-inspection/v1',
    identity: {
      agentId: name,
      agentName: name,
      projectId: 't08564-double',
      mode: 'task',
      scope: `agent:${name}:project:t08564-double`,
      lane: 'primary',
      harness: 'claude',
      frontend: 'claude-code',
      interaction: 'interactive',
    },
    parts: [
      {
        kind: 'prompt',
        partId: 'prompt:template:resolution',
        disposition: {
          kind: 'failed',
          source: { kind: 'compiler', stage: 'context-resolution' },
          reason: 'fixture prompt resolution failed',
        },
        provenance: { contributions: [] },
        value: { zone: 'prompt', name: 'template:resolution', sourceType: 'inline', order: 0 },
      },
      {
        kind: 'capability',
        partId: 'capability:runtime-plan',
        disposition: effective,
        provenance: contribution,
        value: { capabilityId: 'runtime-plan', enabled: true },
      },
      {
        kind: 'runtime-setting',
        partId: 'runtime-setting:locked-env-keys',
        disposition: effective,
        provenance: contribution,
        value: { settingId: 'locked-env-keys', value: ['ASP_AGENT_ROOT'] },
      },
      {
        kind: 'harness',
        partId: 'harness:selected',
        disposition: effective,
        provenance: contribution,
        value: { family: 'claude-code', runtime: 'claude-code-cli', provider: 'anthropic' },
      },
      {
        kind: 'model',
        partId: 'model:selected',
        disposition: effective,
        provenance: contribution,
        value: { provider: 'anthropic', modelId: 'opus[1m]' },
      },
      {
        kind: 'artifact',
        partId: 'artifact:bundle',
        disposition: effective,
        provenance: contribution,
        value: { artifactKind: 'bundle', bundleIdentity: 'bundle:t08564-inspection' },
      },
      {
        kind: 'execution-profile',
        partId: 'execution-profile:profile_t08564',
        disposition: effective,
        provenance: contribution,
        value: { profileId: 'profile_t08564', controllerKind: 'harness-broker' },
      },
    ],
    completeness: { kind: 'partial', missingPartIds: ['prompt:template:resolution'] },
    freshness: { kind: 'unknown', reason: 'The canonical compile produced no lock hash' },
    diagnostics: [
      {
        kind: 'resolution',
        severity: 'error',
        code: 'prompt_resolution_failed',
        message: 'fixture prompt resolution failed',
        partId: 'prompt:template:resolution',
      },
      {
        kind: 'resolution',
        severity: 'error',
        code: 'part_resolution_failed',
        message: 'fixture prompt resolution failed',
        partId: 'prompt:template:resolution',
      },
    ],
  }
}

function promptResponse(script: PromptScript): Record<string, unknown> {
  // Type-declared (T-08563 rev 5 §6), not live-captured.
  if (script === 'absent') return { state: 'absent', code: 'prompt_not_declared' }
  if (script === 'invalid') {
    return {
      state: 'invalid',
      code: 'prompt_resolution_failed',
      message: 'fixture prompt exec failed',
      diagnostics: [
        {
          kind: 'resolution',
          severity: 'error',
          code: 'prompt_resolution_failed',
          message: 'fixture prompt exec failed',
          partId: 'prompt:template:resolution',
        },
      ],
    }
  }
  return {
    state: 'present',
    value: {
      systemPrompt: 'T-08564 system prompt',
      systemPromptMode: 'append',
      reminderContent: 'T-08564 reminder',
      promptSectionSizes: [{ name: 'system', chars: 22 }],
      reminderSectionSizes: [{ name: 'reminder', chars: 18 }],
      promptTotalChars: 22,
      reminderTotalChars: 18,
      totalContextChars: 40,
      nearMaxChars: false,
    },
  }
}

/**
 * Copied from evidence/double-parity/live-m7-prompt/inspect-agentsources-mismatch.json
 * `inspect_absent.reply.result`.
 */
function inspectNonOkResponse(): Record<string, unknown> {
  return {
    schemaVersion: 'aspc-inspect-runtime-placement-response/v1',
    ok: false,
    declaration: {
      schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
      ok: false,
      failure: {
        kind: 'incompatible',
        code: 'configured_context_mismatch',
        message: 'Caller agentsRoot conflicts with aspHome',
      },
    },
  }
}

/**
 * Copied from evidence/double-parity/live-dryrun-compile/capture.json
 * `response.result`; request-derived identity and placement values stay dynamic.
 */
function compileResponse(params: Record<string, unknown>, serving: Release) {
  const compileRequest = (params['compileRequest'] ?? {}) as Record<string, unknown>
  const identity = (compileRequest['identity'] ?? {
    requestId: 'dry-req-t08564',
    operationId: 'dry-op-t08564',
    hostSessionId: 'dry-run-host-session',
    generation: 0,
    runtimeId: 'dry-rt-t08564',
    invocationId: 'dry-inv-t08564',
    traceId: 'dry-trace-t08564',
  }) as RuntimeIdentityAllocation
  const invocationId = identity.invocationId ?? ('dry-inv-t08564' as never)
  const placement = (compileRequest['placement'] ?? {
    agentRoot: '/tmp/t08564-agent',
    projectRoot: '/tmp/t08564-project',
    cwd: '/tmp/t08564-project',
    runMode: 'task',
    bundle: {
      kind: 'agent-project',
      agentName: 'smokey',
      projectRoot: '/tmp/t08564-project',
    },
    dryRun: false,
  }) as Record<string, unknown>
  const cwd = String(placement['cwd'] ?? '/tmp/t08564-project')
  const agentRoot = String(placement['agentRoot'] ?? '/tmp/t08564-agent')
  const aspHome = String(params['aspHome'] ?? '/tmp/t08564-asp-home')
  const projectId = 't08564_smokey'
  const codexHome = `${aspHome}/codex-homes/${projectId}`
  const correlation = {
    requestId: String(identity.requestId),
    hostSessionId: String(identity.hostSessionId),
    operationId: String(identity.operationId),
    runtimeId: String(identity.runtimeId),
    traceId: String(identity.traceId),
  }
  const lockedEnv = {
    CODEX_HOME: codexHome,
    AGENTCHAT_ID: 'smokey',
    ASP_PROJECT: 'hrc-runtime',
    ASP_HOME: aspHome,
    ASP_AGENT_ROOT: agentRoot,
    ASP_AGENT_NAME: 'smokey',
    ASP_AGENT_VAR_DIR: `${agentRoot}/var`,
    ASP_AGENT_STATE_DIR: `${agentRoot}/var/state`,
    ASP_AGENT_CACHE_DIR: `${agentRoot}/var/cache`,
    ASP_AGENT_LOG_DIR: `${agentRoot}/var/logs`,
    ASP_PROJECT_ROOT: String(placement['projectRoot'] ?? cwd),
    ASP_PROJECT_ID: projectId,
    ASP_PROJECT_STATE_DIR: `${agentRoot}/var/state/projects/${projectId}`,
  }
  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
    process: {
      command: '/Users/lherron/.local/bin/codex',
      args: ['--enable', 'goals', 'app-server'],
      cwd,
      lockedEnv,
      harnessTransport: { kind: 'jsonrpc-stdio' },
      limits: { startupTimeoutMs: 20_000, turnTimeoutMs: 900_000, stopGraceMs: 5_000 },
    },
    interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: {
      kind: 'codex-app-server',
      approvalPolicy: 'never',
      permissionPolicy: { mode: 'deny' },
      resumeFallback: 'fail',
    },
    correlation,
  }
  const startRequest: InvocationStartRequest = { spec }
  const profile = {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: 'profile_t08564',
    kind: 'harness-broker',
    interactionMode: 'headless',
    expectedCapabilities: {
      input: {
        user: 'required',
        steer: 'optional',
        appendContext: 'optional',
        localImages: 'optional',
        fileRefs: 'forbidden',
        queue: 'required',
      },
      turns: { concurrency: 'single', interrupt: 'optional' },
      continuation: 'optional',
      permissions: 'none',
      events: {
        assistantDeltas: 'optional',
        toolCalls: 'required',
        usage: 'optional',
        diagnostics: 'optional',
      },
      control: {
        stop: 'optional',
        dispose: 'optional',
        reconcile: 'optional',
        attachReplay: 'optional',
      },
      lifecycle: {
        runtimeRetention: ['keep-alive'],
        harnessRecovery: ['none'],
        turnRetry: ['none'],
        generationFencing: 'optional',
        permissionCancellation: 'optional',
      },
    },
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    brokerOwnership: 'hrc-owned-process',
    harnessInvocation: {
      startRequest,
      specHash: neutralSpecHash(spec),
      startRequestHash: neutralStartRequestHash(startRequest),
    },
    policy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {
        readyInput: 'start-turn',
        busy: { whenBusy: 'reject' },
        supportedKinds: ['user'],
        attachmentPolicy: { localImages: true, fileRefs: false },
      },
      exposurePolicy: { mode: 'none' },
    },
    observability: { correlation: identity },
    profileHash: 'profilehash_t08564',
    compatibilityHash: 'compat_t08564',
  }
  const plan = {
    schemaVersion: 'agent-runtime-plan/v1',
    compiler: { name: 'agent-spaces', version: 't08564-double' },
    compileId: 'compile_t08564',
    createdAt: '2026-09-17T07:51:25.901Z',
    identity,
    placement,
    resolvedBundle: {
      bundleIdentity: 'bundle:t08564',
      runMode: 'task',
      cwd,
      instructions: [
        {
          slot: 'soul',
          ref: 'agent-root:///SOUL.md',
          contentHash: 'sha256:t08564-soul',
        },
      ],
      spaces: [],
    },
    omitPriming: false,
    harness: { family: 'codex', runtime: 'codex-cli', provider: 'openai' },
    model: { provider: 'openai', modelId: 'gpt-5.6-terra' },
    executionProfiles: [profile],
    artifacts: {
      materializedBundleRoot: `${codexHome}/bundles/.versions/t08564/smokey/codex`,
      systemPromptFile: `${codexHome}/bundles/.versions/t08564/smokey/codex/.asp-runtime-artifacts/system-prompts/t08564/system-prompt.md`,
      bundleIdentity: 'bundle:t08564',
    },
    lockedEnv: { lockedEnvKeys: Object.keys(lockedEnv).sort() },
    diagnostics: [],
    planHash: 'planhash_t08564',
  }
  const runtimeCompile = {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: true,
    plan,
    diagnostics: [],
  }
  return {
    schemaVersion: 'aspc-compile-harness-invocation-response/v1',
    ok: true,
    compileResponse: runtimeCompile,
    plan,
    selectedProfile: profile,
    startRequest,
    dispatchRequest: { startRequest },
    diagnostics: [],
    executionRelease: {
      releaseId: serving.releaseId,
      sourceCommit: serving.sourceCommit,
      builtAt: serving.builtAt,
      releaseRoot: serving.releaseRoot,
      worker: {
        protocol: 'harness-broker/0.2',
        executable: `${serving.releaseRoot}/harness-broker`,
        hostedDrivers: ['claude-code-tmux', 'codex-app-server', 'pi-tui-tmux'],
        argvPrefix: ['run', '--transport', 'unix'],
      },
    },
  }
}

/** Copied from evidence/double-parity/real/resolve_ok.json `hello.reply.result`. */
function helloResponse(
  serving: Release,
  options: AspdObservationOptions,
  phaseCapabilities: Record<string, unknown>
) {
  return {
    facadeInfo: { name: 'aspc-facade', version: 't08564-double' },
    protocolVersion: options.protocolVersion ?? 'aspc/0.1',
    capabilities: {
      compileRuntimePlan: true,
      catalogAgents: true,
      inspectAgent: true,
      catalogAgentInspection: true,
      inspectAgentSelection: true,
      compileHarnessInvocation: true,
      resolveRuntimeDeclaration: true,
      inspectRuntimePlacement: true,
      inspectRuntimePlacementPreparationCorrelation: true,
      observeRuntimeCapability: true,
      observeContinuationArtifact: true,
      compileAndStart: false,
      prepareProcessInvocation: true,
      resolveDesktopIdentity: true,
      admitDesktopRegistration: true,
      prepareDesktopObserver: true,
      cohostedBroker: false,
      transports: ['unix-jsonrpc-ndjson'],
      ...phaseCapabilities,
    },
    release: {
      releaseId: serving.releaseId,
      sourceCommit: serving.sourceCommit,
      builtAt: serving.builtAt,
    },
  }
}

/** Capability observation: every fixture harness is available (the gate's
 * `preparation: present` composite). Presence of the harness binary itself is
 * covered by the deterministic-start/fake-broker shims in kicker tests.
 */
function capabilityResponse(params: Record<string, unknown>): Record<string, unknown> {
  const harness = typeof params['harness'] === 'string' ? (params['harness'] as string) : 'claude'
  return {
    schemaVersion: 'aspc-observe-runtime-capability-response/v1',
    ok: true,
    harness: { requested: harness },
    registration: { state: 'present', code: 'registered' },
    nativeRuntime: { state: 'present', code: 'native_available' },
    credentials: { state: 'present', code: 'credentials_not_required' },
    preparation: { state: 'present', code: 'preparation_ready' },
    diagnostics: [],
  }
}

/**
 * Copied from evidence/double-parity/real/inspect_present.json and
 * evidence/double-parity/real/inspect_absent.json `inspect_*.reply.result`.
 */
function inspectResponse(
  context: Record<string, unknown>,
  prompt: PromptScript
): Record<string, unknown> {
  return {
    schemaVersion: 'aspc-inspect-runtime-placement-response/v1',
    ok: true,
    declaration: inspectDeclaration(context),
    inspection: inspectionResult(context),
    prompt: promptResponse(prompt),
    effectiveEnvironmentHash: 'sha256:t08564-environment',
  }
}

function resolveDeclarationResult(
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

export function startAspdObservationDouble(
  socketPath: string,
  serving: Release,
  options: AspdObservationOptions = {}
): AspdObservationDouble {
  const state: AspdObservationDouble = {
    serving,
    connections: [],
    openConnections: 0,
    stop: () => undefined,
  }
  if (options.socketAbsent === true) return state

  const capabilities = {
    resolveRuntimeDeclaration: true,
    inspectRuntimePlacement: true,
    compileHarnessInvocation: true,
    observeRuntimeCapability: true,
    ...options.capabilities,
  }
  const buffers = new Map<unknown, string>()
  const pending = new Map<unknown, Buffer>()
  const ledgers = new Map<unknown, ObservationConnection>()
  const flush = (socket: { write(data: Buffer): number }) => {
    const queued = pending.get(socket)
    if (queued === undefined || queued.length === 0) return
    const written = socket.write(queued)
    pending.set(socket, queued.subarray(Math.max(written, 0)))
  }
  const send = (socket: { write(data: Buffer): number }, payload: Record<string, unknown>) => {
    const bytes = Buffer.from(`${JSON.stringify(payload)}\n`)
    pending.set(socket, Buffer.concat([pending.get(socket) ?? Buffer.alloc(0), bytes]))
    flush(socket)
  }
  const reply = (socket: { write(data: Buffer): number }, id: unknown, result: unknown) => {
    send(socket, { jsonrpc: '2.0', id, result })
  }

  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        state.openConnections += 1
        const ledger = { methods: [], requests: [] }
        state.connections.push(ledger)
        ledgers.set(socket, ledger)
        buffers.set(socket, '')
      },
      drain(socket) {
        flush(socket as never)
      },
      close(socket) {
        state.openConnections -= 1
        ledgers.delete(socket)
        buffers.delete(socket)
        pending.delete(socket)
      },
      data(socket, chunk) {
        let buffer = (buffers.get(socket) ?? '') + chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (line.trim().length === 0) continue
          const message = JSON.parse(line) as {
            id: unknown
            method: string
            params?: Record<string, unknown>
          }
          const params = message.params ?? {}
          const ledger = ledgers.get(socket)
          ledger?.methods.push(message.method)
          ledger?.requests.push({ method: message.method, params })

          if (message.method === 'aspc.hello') {
            reply(socket as never, message.id, helloResponse(serving, options, capabilities))
          } else if (message.method === 'aspc.resolveRuntimeDeclaration') {
            const context = (params['context'] ?? {}) as Record<string, unknown>
            const result = resolveDeclarationResult(context, options)
            reply(socket as never, message.id, result)
          } else if (message.method === 'aspc.observeRuntimeCapability') {
            reply(socket as never, message.id, capabilityResponse(params))
          } else if (message.method === 'aspc.inspectRuntimePlacement') {
            const context = (params['context'] ?? {}) as Record<string, unknown>
            reply(
              socket as never,
              message.id,
              options.inspectNonOk === true
                ? inspectNonOkResponse()
                : inspectResponse(context, options.prompt ?? 'present')
            )
          } else if (message.method === 'aspc.compileHarnessInvocation') {
            reply(socket as never, message.id, compileResponse(params, serving))
          } else {
            send(socket as never, {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `method not found: ${message.method}` },
            })
          }
        }
        buffers.set(socket, buffer)
      },
    },
  })
  state.stop = () => listener.stop(true)
  return state
}
