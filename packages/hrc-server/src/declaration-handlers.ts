/**
 * T-08564 Phase A: declaration-backed runtime intent resolution and plan preview.
 *
 * ASP interprets agent profiles, project targets, priming and harness catalogs;
 * HRC decides placement policy, directive grammar and deny-listing, and owns
 * intent assembly and every refusal. Both routes reach aspd only through
 * `withAspdObservationSession` — no in-process declaration parsing, no fallback.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import {
  DENIED_PROVISION_OVERRIDE_KEYS,
  type ProvisioningScalars,
  parseScopeRef,
  resolveQualifiedScopeInput,
} from 'agent-scope'
import {
  type DeclarationSourceState,
  HrcBadRequestError,
  type HrcDomainError,
  HrcErrorCode,
  type HrcExecutionMode,
  type HrcRuntimeIntent,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
  type ResolveRuntimeIntentResponse,
  formatProfileProvisioningStrippedWarning,
  splitSessionRef,
} from 'hrc-core'
import { getAspHome } from 'hrc-core'
import type {
  AspcDeclarationDiagnostic,
  AspcInspectRuntimePlacementRequest,
  AspcResolveRuntimeDeclarationResponse,
  AspcRuntimeDeclarationContext,
  AspcRuntimePromptObservation,
} from 'spaces-aspc-protocol'

import { withAspdObservationSession } from './agent-spaces-adapter/aspd-observation-client.js'
import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import {
  type BrokerRunPreviewPromptZones,
  previewCompileIds,
  projectBrokerRunPreview,
  resolvePreviewIntent,
} from './broker-run-preview.js'
import { observedRuntimeBundle } from './observed-runtime-bundle.js'
import { resolvePlacementInProcess } from './placements-resolve.js'
import { isRecord, parseJsonBody } from './server-parsers.js'
import { json } from './server-util.js'

const RUN_MODES = new Set(['query', 'heartbeat', 'task', 'maintenance'])
const EXECUTION_MODES = new Set(['headless', 'interactive', 'nonInteractive'])

type ResolveBodyOptions = {
  runMode: AspcRuntimeDeclarationContext['runMode']
  interactive: boolean
  preferredMode: HrcExecutionMode
  allowInteractiveSurfaceReuse?: boolean | undefined
  initialPrompt?: string | undefined
}

type ResolveByPathsBody = ResolveBodyOptions & {
  agentId: string
  agentRoot: string
  projectId?: string | undefined
  projectRoot?: string | undefined
  cwd: string
  provision?: Record<string, unknown> | undefined
  agentSources?: { agentsRoot?: string | undefined; aspHome?: string | undefined } | undefined
}

type ResolveByScopeBody = ResolveBodyOptions & {
  scopeRef: string
  materializationIntent?: string | undefined
}

type ResolveBody = ResolveByPathsBody | ResolveByScopeBody

function badRequest(message: string, field: string): HrcBadRequestError {
  return new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, message, { field })
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`${field} is required`, field)
  }
  return value
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`${field} must be a non-empty string`, field)
  }
  return value
}

function parseResolveBody(input: unknown): ResolveBody {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const runMode = input['runMode'] ?? 'task'
  if (typeof runMode !== 'string' || !RUN_MODES.has(runMode)) {
    throw badRequest('runMode must be query, heartbeat, task, or maintenance', 'runMode')
  }
  const preferredMode = input['preferredMode'] ?? 'nonInteractive'
  if (typeof preferredMode !== 'string' || !EXECUTION_MODES.has(preferredMode)) {
    throw badRequest(
      'preferredMode must be headless, interactive, or nonInteractive',
      'preferredMode'
    )
  }
  const interactive = input['interactive'] ?? false
  if (typeof interactive !== 'boolean')
    throw badRequest('interactive must be a boolean', 'interactive')
  const reuse = input['allowInteractiveSurfaceReuse']
  if (reuse !== undefined && typeof reuse !== 'boolean') {
    throw badRequest(
      'allowInteractiveSurfaceReuse must be a boolean',
      'allowInteractiveSurfaceReuse'
    )
  }
  const initialPrompt = input['initialPrompt']
  if (initialPrompt !== undefined && typeof initialPrompt !== 'string') {
    throw badRequest('initialPrompt must be a string', 'initialPrompt')
  }
  const provision = input['provision']
  if (provision !== undefined && !isRecord(provision)) {
    throw badRequest('provision must be an object', 'provision')
  }
  const scopeRef = optionalString(input, 'scopeRef')
  if (scopeRef !== undefined) {
    for (const field of [
      'agentId',
      'agentRoot',
      'projectId',
      'projectRoot',
      'cwd',
      'provision',
      'agentSources',
    ]) {
      if (input[field] !== undefined) {
        throw badRequest(`${field} cannot be combined with scopeRef`, field)
      }
    }
    return {
      scopeRef,
      materializationIntent: optionalString(input, 'materializationIntent'),
      runMode: runMode as AspcRuntimeDeclarationContext['runMode'],
      interactive,
      preferredMode: preferredMode as HrcExecutionMode,
      allowInteractiveSurfaceReuse: reuse as boolean | undefined,
      initialPrompt: initialPrompt as string | undefined,
    }
  }
  const sourcesRaw = input['agentSources']
  if (sourcesRaw !== undefined && !isRecord(sourcesRaw)) {
    throw badRequest('agentSources must be an object', 'agentSources')
  }
  const agentSources =
    sourcesRaw === undefined
      ? undefined
      : {
          ...(optionalString(sourcesRaw, 'agentsRoot') !== undefined
            ? { agentsRoot: optionalString(sourcesRaw, 'agentsRoot') }
            : {}),
          ...(optionalString(sourcesRaw, 'aspHome') !== undefined
            ? { aspHome: optionalString(sourcesRaw, 'aspHome') }
            : {}),
        }
  return {
    agentId: requireString(input, 'agentId'),
    agentRoot: requireString(input, 'agentRoot'),
    projectId: optionalString(input, 'projectId'),
    projectRoot: optionalString(input, 'projectRoot'),
    cwd: requireString(input, 'cwd'),
    runMode: runMode as AspcRuntimeDeclarationContext['runMode'],
    interactive,
    preferredMode: preferredMode as HrcExecutionMode,
    allowInteractiveSurfaceReuse: reuse as boolean | undefined,
    initialPrompt: initialPrompt as string | undefined,
    provision: provision as Record<string, unknown> | undefined,
    agentSources,
  }
}

/** Resolve a socket caller's scope into daemon-local declaration inputs. */
async function resolveScopeBody(body: ResolveByScopeBody): Promise<ResolveByPathsBody> {
  let parsed: ReturnType<typeof parseScopeRef>
  try {
    parsed = parseScopeRef(body.scopeRef)
  } catch (error) {
    throw badRequest(
      `scopeRef is not a valid scope: ${error instanceof Error ? error.message : String(error)}`,
      'scopeRef'
    )
  }
  const placement = await resolvePlacementInProcess({
    agentId: parsed.agentId,
    ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
    ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
    cwd: process.cwd(),
    runMode: body.runMode,
  })
  if (placement.agentRoot === undefined) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.DECLARATION_INVALID,
      `agent "${parsed.agentId}" has no resolved agent root`,
      { source: 'agent-profile', agentId: parsed.agentId }
    )
  }
  let provision: ProvisioningScalars | undefined
  const block = body.materializationIntent?.trim()
  if (block !== undefined && block.length > 0) {
    try {
      provision = resolveQualifiedScopeInput(
        `${body.scopeRef}${block.startsWith('+') ? '' : '+'}${block}`
      ).directives
    } catch {
      // Match the established kicker rule: a malformed carried override must
      // not strand the target; resolve its declaration without the override.
    }
  }
  return {
    agentId: parsed.agentId,
    agentRoot: placement.agentRoot,
    ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
    ...(placement.projectRoot !== undefined ? { projectRoot: placement.projectRoot } : {}),
    cwd: placement.cwd ?? process.cwd(),
    runMode: body.runMode,
    interactive: body.interactive,
    preferredMode: body.preferredMode,
    ...(body.allowInteractiveSurfaceReuse !== undefined
      ? { allowInteractiveSurfaceReuse: body.allowInteractiveSurfaceReuse }
      : {}),
    ...(body.initialPrompt !== undefined ? { initialPrompt: body.initialPrompt } : {}),
    ...(provision !== undefined ? { provision } : {}),
  }
}

/** HRC directive law: only top-level scalars ride, and deny-listed keys never do. */
function authorizedScalars(scalars: Record<string, unknown> | undefined): ProvisioningScalars {
  const carried: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(scalars ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      carried[key] = value
    }
  }
  for (const denied of DENIED_PROVISION_OVERRIDE_KEYS) {
    delete carried[denied]
  }
  return carried as ProvisioningScalars
}

function declarationContext(body: ResolveByPathsBody): AspcRuntimeDeclarationContext {
  const directives = authorizedScalars(body.provision)
  return {
    agentId: body.agentId,
    agentRoot: body.agentRoot,
    project:
      body.projectRoot !== undefined
        ? {
            mode: 'root',
            projectRoot: body.projectRoot,
            ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
          }
        : { mode: 'none' },
    cwd: body.cwd,
    runMode: body.runMode,
    ...(body.agentSources !== undefined && Object.keys(body.agentSources).length > 0
      ? { agentSources: body.agentSources }
      : {}),
    ...(Object.keys(directives).length > 0
      ? { provisionDirectives: directives as Record<string, string | number | boolean> }
      : {}),
  }
}

const SOURCE_BY_CODE: Record<string, string> = {
  agent_not_found: 'agent-profile',
  agent_profile_invalid: 'agent-profile',
  project_targets_invalid: 'project-targets',
  selected_target_invalid: 'selected-target',
  priming_invalid: 'priming',
}

function agentInstallIncompleteMessage(agentRoot: string): string {
  return `buildRuntimeBundleRef: agent-profile.toml not found at ${agentRoot}/agent-profile.toml — agent install incomplete`
}

/** Project a producer non-ok declaration into the HRC refusal the route owns. */
function refuseDeclaration(
  response: Exclude<AspcResolveRuntimeDeclarationResponse, { ok: true }>,
  agentRoot: string,
  operation: string
): HrcDomainError {
  if ('resolution' in response) {
    const { resolution } = response
    if (resolution.code === 'agent_not_found') {
      return new HrcUnprocessableEntityError(
        HrcErrorCode.DECLARATION_INVALID,
        agentInstallIncompleteMessage(agentRoot),
        {
          source: 'agent-profile',
          producerCode: resolution.code,
          searchedAgentRoots: response.searchedAgentRoots,
          diagnostics: resolution.diagnostics,
        }
      )
    }
    return new HrcUnprocessableEntityError(HrcErrorCode.DECLARATION_INVALID, resolution.message, {
      source:
        resolution.diagnostics[0]?.source ?? SOURCE_BY_CODE[resolution.code] ?? 'agent-profile',
      producerCode: resolution.code,
      diagnostics: resolution.diagnostics,
    })
  }
  const { failure } = response
  if (failure.code === 'configured_context_mismatch') {
    return new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, failure.message, {
      code: 'configured_context_mismatch',
      route: 'aspd',
      operation,
    })
  }
  return new HrcRuntimeUnavailableError(
    `declaration evidence ${failure.kind}: ${failure.message}`,
    {
      code: `aspd_observation_${failure.kind}`,
      route: 'aspd',
      operation,
      producerCode: failure.code,
    }
  )
}

function sourceStates(
  source: Extract<AspcResolveRuntimeDeclarationResponse, { ok: true }>['source']
): ResolveRuntimeIntentResponse['declaration']['source'] {
  return {
    agentProfile: source.agentProfile.state as DeclarationSourceState,
    projectTargets: source.projectTargets.state as DeclarationSourceState,
    selectedTarget: source.selectedTarget.state as DeclarationSourceState,
    priming: source.priming.state as DeclarationSourceState,
  }
}

function invalidProfileWarning(
  declaration: Extract<AspcResolveRuntimeDeclarationResponse, { ok: true }>,
  agentId: string,
  requestAgentRoot: string,
  provision: ProvisioningScalars
): string | undefined {
  const profile = declaration.source.agentProfile
  if (profile.state !== 'invalid') return undefined
  const diagnostics: AspcDeclarationDiagnostic[] = profile.diagnostics
  return formatProfileProvisioningStrippedWarning({
    agentId,
    // Today's WARN names the caller's agent root joined with the profile file,
    // not the producer's canonicalized diagnostic path, so the bytes stay equal.
    profilePath: join(requestAgentRoot, 'agent-profile.toml'),
    errorMessage: diagnostics.map((diagnostic) => diagnostic.message).join(' '),
    survivingProvisionKeys: Object.keys(provision),
  })
}

export async function handleResolveRuntimeIntent(request: Request): Promise<Response> {
  const parsed = parseResolveBody(await parseJsonBody(request))
  const body = 'scopeRef' in parsed ? await resolveScopeBody(parsed) : parsed
  const operation = 'resolveRuntimeDeclaration'
  return await withAspdObservationSession([operation], async ({ service, client }) => {
    const declaration = await client.resolveRuntimeDeclaration({
      schemaVersion: 'aspc-resolve-runtime-declaration-request/v1',
      context: declarationContext(body),
    })
    if (!declaration.ok) {
      throw refuseDeclaration(declaration, body.agentRoot, operation)
    }
    // A caller-supplied root is read directly, so a root without a profile is an
    // ok arm with the profile absent rather than agent_not_found. E1 keeps
    // today's refusal: an intent is never assembled for an uninstalled agent.
    if (declaration.source.agentProfile.state === 'absent') {
      throw new HrcUnprocessableEntityError(
        HrcErrorCode.DECLARATION_INVALID,
        agentInstallIncompleteMessage(body.agentRoot),
        {
          source: 'agent-profile',
          producerCode: declaration.source.agentProfile.code,
          diagnostics: declaration.diagnostics,
        }
      )
    }

    const provision = authorizedScalars(declaration.provisioning.scalars)
    const placement = declaration.placement
    const bundle = observedRuntimeBundle(placement.bundle)
    if (bundle === undefined) {
      throw new HrcUnprocessableEntityError(
        HrcErrorCode.DECLARATION_INVALID,
        'declaration returned an unsupported placement bundle',
        { source: 'placement.bundle' }
      )
    }
    // M1: HRC owns dryRun and every other intent field the observation does not
    // define; it never copies the observation placement verbatim.
    const intent: HrcRuntimeIntent = {
      placement: {
        agentRoot: placement.agentRoot,
        ...(placement.projectRoot !== undefined ? { projectRoot: placement.projectRoot } : {}),
        cwd: placement.cwd,
        runMode: placement.runMode,
        bundle,
        dryRun: false,
      },
      harness: {
        interactive: body.interactive,
      },
      execution: {
        preferredMode: body.preferredMode,
        ...(body.allowInteractiveSurfaceReuse !== undefined
          ? { allowInteractiveSurfaceReuse: body.allowInteractiveSurfaceReuse }
          : {}),
      },
      ...(body.initialPrompt !== undefined ? { initialPrompt: body.initialPrompt } : {}),
    }

    const warning = invalidProfileWarning(declaration, body.agentId, body.agentRoot, provision)
    const response: ResolveRuntimeIntentResponse = {
      intent,
      declaration: {
        release: {
          releaseId: service.release.releaseId,
          sourceCommit: service.release.sourceCommit,
        },
        agentSources: declaration.agentSources,
        source: sourceStates(declaration.source),
        warnings: warning === undefined ? [] : [warning],
      },
    }
    return json(response)
  })
}

function parsePreviewBody(input: unknown): { intent: HrcRuntimeIntent; sessionRef: string } {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const intent = input['intent']
  if (!isRecord(intent) || !isRecord(intent['placement']) || !isRecord(intent['harness'])) {
    throw badRequest('intent with placement and harness is required', 'intent')
  }
  return {
    intent: intent as unknown as HrcRuntimeIntent,
    sessionRef: requireString(input, 'sessionRef'),
  }
}

/** Preview inspection context for the same placement the compile uses. */
function previewInspectionContext(
  intent: HrcRuntimeIntent,
  sessionRef: string
): AspcRuntimeDeclarationContext {
  const placement = intent.placement as unknown as Record<string, unknown>
  const scopeRef = sessionRef.includes('/lane:') ? splitSessionRef(sessionRef).scopeRef : sessionRef
  let agentId: string | undefined
  let projectId: string | undefined
  let taskId: string | undefined
  try {
    const parsed = parseScopeRef(scopeRef)
    agentId = parsed.agentId
    projectId = parsed.projectId
    taskId = parsed.taskId
  } catch {
    // A non-agent session ref still previews; the bundle names the agent.
  }
  const bundle = placement['bundle'] as { agentName?: unknown } | undefined
  const bundleAgent = typeof bundle?.agentName === 'string' ? bundle.agentName : undefined
  const agentRoot = String(placement['agentRoot'])
  const projectRoot = placement['projectRoot']
  // The compile names the project from the session scope and applies the
  // intent's provision directives, so inspection observes the same two inputs
  // rather than the directory basename and the undirected profile.
  const directives = authorizedScalars(intent.provision as Record<string, unknown> | undefined)
  return {
    agentId: agentId ?? bundleAgent ?? agentRoot.split('/').filter(Boolean).at(-1) ?? 'agent',
    agentRoot,
    project:
      typeof projectRoot === 'string'
        ? { mode: 'root', projectRoot, ...(projectId !== undefined ? { projectId } : {}) }
        : { mode: 'none' },
    cwd: String(placement['cwd'] ?? projectRoot ?? agentRoot),
    runMode: (placement['runMode'] as AspcRuntimeDeclarationContext['runMode']) ?? 'task',
    ...(taskId !== undefined ? { taskId } : {}),
    ...(Object.keys(directives).length > 0
      ? { provisionDirectives: directives as Record<string, string | number | boolean> }
      : {}),
  }
}

type PromptProjection = {
  zones?: BrokerRunPreviewPromptZones | undefined
  promptResolution?: Record<string, unknown> | undefined
}

function projectPrompt(prompt: AspcRuntimePromptObservation): PromptProjection {
  if (prompt.state === 'absent') return {}
  if (prompt.state === 'invalid') {
    return {
      promptResolution: {
        state: prompt.state,
        code: prompt.code,
        message: prompt.message,
        diagnostics: prompt.diagnostics,
      },
    }
  }
  const value = prompt.value
  return {
    zones: {
      systemPrompt: value.systemPrompt,
      systemPromptMode: value.systemPromptMode,
      ...(value.reminderContent !== undefined && value.reminderContent.length > 0
        ? { reminderContent: value.reminderContent }
        : {}),
      promptSectionSizes: value.promptSectionSizes.map((size) => `${size.name}=${size.chars}`),
      reminderSectionSizes: value.reminderSectionSizes.map((size) => `${size.name}=${size.chars}`),
      totalContextChars: value.totalContextChars,
      ...(value.maxChars !== undefined ? { maxChars: value.maxChars } : {}),
      nearMaxChars: value.nearMaxChars,
    },
  }
}

export async function handleRunPreview(request: Request): Promise<Response> {
  const { intent, sessionRef } = parsePreviewBody(await parseJsonBody(request))
  const previewIntent = resolvePreviewIntent(intent)
  // One admitted connection serves both operations, so the plan and the prompt
  // facts always come from the same aspd release. PC-1 admits the preparation
  // correlation capability on the same connection: absent, the preview is
  // refused with aspd_capability_missing instead of an uncorrelated inspection.
  return await withAspdObservationSession(
    [
      'compileHarnessInvocation',
      'inspectRuntimePlacement',
      'inspectRuntimePlacementPreparationCorrelation',
    ],
    async ({ service, client }) => {
      const runtimeId = `dry-rt-${randomUUID()}`
      const aspHome = getAspHome()
      const compiled = await compileBrokerRuntimePlan(
        {
          intent: previewIntent,
          scopeRef: sessionRef.includes('/lane:')
            ? splitSessionRef(sessionRef).scopeRef
            : sessionRef,
          hostSessionId: 'dry-run-host-session',
          generation: 0,
          continuation: undefined,
        },
        {
          compileHarnessInvocation: (compileRequest) =>
            client.compileHarnessInvocation({ ...compileRequest, aspHome }),
          ids: previewCompileIds(runtimeId),
        }
      )
      if (!compiled.admitted) {
        return json(null)
      }

      // PC-1: the inspection carries the correlation and dispatchEnv the same
      // preview compiled. The compile echoes the intent placement through its
      // request, so these are the compiled values; dispatchEnv stays inert.
      const compiledPlacement = previewIntent.placement as unknown as Record<string, unknown>
      const inspected = await client.inspectRuntimePlacement({
        schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
        context: previewInspectionContext(previewIntent, sessionRef),
        preparationCorrelation: compiledPlacement[
          'correlation'
        ] as AspcInspectRuntimePlacementRequest['preparationCorrelation'],
        dispatchEnv: compiledPlacement['dispatchEnv'] as Record<string, string> | undefined,
      })
      const prompt: PromptProjection = inspected.ok
        ? projectPrompt(inspected.prompt)
        : {
            promptResolution: {
              state: 'unavailable',
              declaration: inspected.declaration,
            },
          }
      const preview = projectBrokerRunPreview(compiled, prompt.zones)
      return json({
        ...preview,
        ...(prompt.promptResolution !== undefined
          ? { promptResolution: prompt.promptResolution }
          : {}),
        ...(preview.release === undefined
          ? {
              release: {
                releaseId: service.release.releaseId,
                sourceCommit: service.release.sourceCommit,
              },
            }
          : {}),
      })
    }
  )
}
