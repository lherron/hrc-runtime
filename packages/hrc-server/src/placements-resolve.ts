/**
 * T-08597 — `POST /v1/placements/resolve`: scope → placement as ONE daemon
 * capability.
 *
 * Neither `/v1/sessions/resolve` (session lookup) nor `/v1/declarations/resolve`
 * (requires agentRoot+cwd as input) resolves a scope into placement. This route
 * does: from `{scopeRef | agentId+projectId, cwd?}` it returns agentRoot
 * (agents-root default + existence resolution), projectRoot (explicit override,
 * wrkq registry, marker scan, sibling fallback, task-worktree refinement),
 * resolved cwd, bundle, harness {provider, frontend, effectiveHarness,
 * transport, interactive}, identity {role, operator}, and the authoritative
 * agentSources (aspHome per the T-08597 ruling).
 *
 * Ownership: projectId inference, marker discovery, registry/sibling/worktree
 * policy = HRC (vendored conventions + placement-policy, no ASP imports).
 * Profile/targets facts, bundle, harness catalog facts = ASP interpretation
 * observed from aspd's `resolveRuntimeDeclaration` IN-PROCESS (no self-HTTP).
 * `transport` arrives on the provisioning observation (ASP T-08600); typed
 * locally as optional so the route tolerates an aspd that predates it.
 */

import { parseScopeRef } from 'agent-scope'
import {
  type DeclarationSourceState,
  type HarnessTransport,
  HrcBadRequestError,
  HrcErrorCode,
  HrcUnprocessableEntityError,
  type ResolvePlacementResponse,
  buildInvalidProfileWarning,
  getAgentsRoot,
  inferProjectIdFromCwd,
  refineTaskWorktree,
  resolveCanonicalProjectRoot,
} from 'hrc-core'
import type { WrkqProjectRegistryEntry } from 'hrc-core'
import type {
  AspcResolveRuntimeDeclarationResponse,
  AspcRuntimeDeclarationContext,
} from 'spaces-aspc-protocol'

import { withAspdObservationSession } from './agent-spaces-adapter/aspd-observation-client.js'
import { resolveRegisteredProjectRoot } from './federation/project-registry-roots.js'
import { isRecord, parseJsonBody } from './server-parsers.js'
import { json } from './server-util.js'

/** Local view of the provisioning observation: `transport` is required on the
 * ok path since ASP T-08600 (asp-32a8e0d6767f) but typed optional here so this
 * worktree builds against the pre-T-08600 contract package without a lock
 * change. The route projects transport only when the observation carries it. */
type ProvisioningObservation = {
  scalars: Record<string, string | number | boolean>
  declaredHarness?: string | undefined
  effectiveHarness: string
  frontend: string
  provider: 'anthropic' | 'openai'
  family: string
  runtime: string
  transport?: HarnessTransport | undefined
}

function badRequest(message: string, field: string): HrcBadRequestError {
  return new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, message, { field })
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`${field} must be a non-empty string`, field)
  }
  return value
}

type ParsedPlacementInput = {
  agentId: string
  projectId?: string | undefined
  taskId?: string | undefined
  cwd: string
  projectRootOverride?: string | undefined
  agentRootOverride?: string | undefined
  runMode: AspcRuntimeDeclarationContext['runMode']
  taskWorktreeAssociation?: 'strict' | 'advisory' | undefined
  projectOrigin?: 'explicit' | 'inferred' | undefined
  registryProjects?: WrkqProjectRegistryEntry[] | undefined
  projectSearchRoots?: string[] | undefined
}

const RUN_MODES = new Set(['query', 'heartbeat', 'task', 'maintenance'])

function parsePlacementBody(input: unknown): ParsedPlacementInput {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  let agentId: string | undefined
  let projectId: string | undefined
  let taskId: string | undefined
  const scopeRef = optionalString(input, 'scopeRef')
  if (scopeRef !== undefined) {
    let parsed: { agentId: string; projectId?: string; taskId?: string }
    try {
      parsed = parseScopeRef(scopeRef)
    } catch (error) {
      throw badRequest(
        `scopeRef is not a valid scope: ${error instanceof Error ? error.message : String(error)}`,
        'scopeRef'
      )
    }
    agentId = parsed.agentId
    projectId = parsed.projectId
    taskId = parsed.taskId
  }
  const directAgent = optionalString(input, 'agentId')
  if (directAgent !== undefined) agentId = directAgent
  const directProject = optionalString(input, 'projectId')
  if (directProject !== undefined) projectId = directProject
  const directTask = optionalString(input, 'taskId')
  if (directTask !== undefined) taskId = directTask
  if (agentId === undefined) throw badRequest('agentId or scopeRef is required', 'agentId')

  const runModeRaw = input['runMode'] ?? 'task'
  if (typeof runModeRaw !== 'string' || !RUN_MODES.has(runModeRaw)) {
    throw badRequest('runMode must be query, heartbeat, task, or maintenance', 'runMode')
  }
  const association = input['taskWorktreeAssociation'] ?? 'strict'
  if (association !== 'strict' && association !== 'advisory') {
    throw badRequest(
      "taskWorktreeAssociation must be 'strict' or 'advisory'",
      'taskWorktreeAssociation'
    )
  }
  const projectOriginRaw = input['projectOrigin']
  if (
    projectOriginRaw !== undefined &&
    projectOriginRaw !== 'explicit' &&
    projectOriginRaw !== 'inferred'
  ) {
    throw badRequest("projectOrigin must be 'explicit' or 'inferred'", 'projectOrigin')
  }
  const registryProjectsRaw = input['registryProjects']
  if (registryProjectsRaw !== undefined && !Array.isArray(registryProjectsRaw)) {
    throw badRequest('registryProjects must be an array', 'registryProjects')
  }
  const projectSearchRootsRaw = input['projectSearchRoots']
  if (
    projectSearchRootsRaw !== undefined &&
    (!Array.isArray(projectSearchRootsRaw) ||
      !projectSearchRootsRaw.every((root) => typeof root === 'string'))
  ) {
    throw badRequest('projectSearchRoots must be an array of strings', 'projectSearchRoots')
  }
  const cwdRaw = optionalString(input, 'cwd')
  return {
    agentId,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    cwd: cwdRaw ?? process.cwd(),
    ...(optionalString(input, 'projectRoot') !== undefined
      ? { projectRootOverride: optionalString(input, 'projectRoot') as string }
      : {}),
    ...(optionalString(input, 'agentRoot') !== undefined
      ? { agentRootOverride: optionalString(input, 'agentRoot') as string }
      : {}),
    runMode: runModeRaw as AspcRuntimeDeclarationContext['runMode'],
    taskWorktreeAssociation: association,
    ...(projectOriginRaw !== undefined
      ? { projectOrigin: projectOriginRaw as 'explicit' | 'inferred' }
      : {}),
    ...(Array.isArray(registryProjectsRaw)
      ? { registryProjects: registryProjectsRaw as WrkqProjectRegistryEntry[] }
      : {}),
    ...(Array.isArray(projectSearchRootsRaw)
      ? { projectSearchRoots: projectSearchRootsRaw as string[] }
      : {}),
  }
}

type PlacementPolicyBits = {
  projectId: string | undefined
  projectExplicit: boolean
  canonicalRoot: string | undefined
  canonicalSource:
    | 'explicit-override'
    | 'wrkq-registry'
    | 'marker-scan'
    | 'sibling-fallback'
    | undefined
  worktreeBranch: string | undefined
  worktreeWarning: string | undefined
}

function assemblePlacementResponse(
  body: ParsedPlacementInput,
  observed: Extract<AspcResolveRuntimeDeclarationResponse, { ok: true }>,
  service: { release: { releaseId: string; sourceCommit: string } },
  policy: PlacementPolicyBits
): ResolvePlacementResponse {
  const {
    projectId,
    projectExplicit,
    canonicalRoot,
    canonicalSource,
    worktreeBranch,
    worktreeWarning,
  } = policy
  const provisioning = observed.provisioning as unknown as ProvisioningObservation
  const invalidWarning =
    observed.source.agentProfile.state === 'invalid'
      ? buildInvalidProfileWarning({
          agentId: body.agentId,
          agentRoot: observed.placement.agentRoot,
          diagnosticMessages: observed.diagnostics.map((diagnostic) => diagnostic.message),
          survivingProvisionKeys: Object.keys(provisioning.scalars),
        })
      : undefined
  const placement = observed.placement
  const observedProjectRoot = placement.projectRoot
  const cwd = observedProjectRoot ?? placement.cwd ?? placement.agentRoot

  // Resolution metadata mirrors hrc-sdk's resolver sources so SDK results
  // keep their shape. Sibling/task-worktree sources are the route's
  // consolidation delta (listed in the parity table).
  const resolutionSource =
    worktreeBranch !== undefined
      ? 'task-worktree'
      : (canonicalSource ??
        (projectExplicit ? 'inferred' : projectId !== undefined ? 'inferred' : 'projectless'))
  const reason =
    worktreeBranch !== undefined && canonicalRoot !== undefined
      ? `cwd from task worktree ${canonicalRoot}, branch ${worktreeBranch}`
      : canonicalRoot !== undefined
        ? canonicalSource === 'wrkq-registry'
          ? `cwd from wrkq registry root ${canonicalRoot}`
          : canonicalSource === 'marker-scan'
            ? `cwd from marker scan ${canonicalRoot}`
            : canonicalSource === 'sibling-fallback'
              ? `cwd from sibling fallback ${canonicalRoot}`
              : `cwd from explicit project root ${canonicalRoot}`
        : projectId !== undefined
          ? `cwd from inferred project ${projectId}`
          : 'cwd from agent root (project-less scope)'

  const response: ResolvePlacementResponse = {
    agentId: body.agentId,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
    agentRoot: placement.agentRoot,
    ...(observedProjectRoot !== undefined ? { projectRoot: observedProjectRoot } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(placement.bundle !== undefined
      ? { bundle: placement.bundle as ResolvePlacementResponse['bundle'] }
      : {}),
    ...(observed.bundle?.identity !== undefined
      ? { bundleIdentity: observed.bundle.identity }
      : {}),
    harness: {
      provider: provisioning.provider,
      frontend: provisioning.frontend,
      effectiveHarness: provisioning.effectiveHarness,
      ...(provisioning.transport !== undefined ? { transport: provisioning.transport } : {}),
      ...(provisioning.transport !== undefined
        ? { interactive: provisioning.transport !== 'sdk' }
        : {}),
    },
    provision: {
      scalars: provisioning.scalars,
      ...(provisioning.declaredHarness !== undefined
        ? { declaredHarness: provisioning.declaredHarness }
        : {}),
    },
    policy: {
      claimsTask: observed.policy.claimsTask,
      ...(observed.policy.provisioningNode !== undefined
        ? { provisioningNode: observed.policy.provisioningNode }
        : {}),
      placement: {
        pins: observed.policy.placement.pins,
        homes: observed.policy.placement.homes,
      },
    },
    identity: {
      ...(observed.identity.role !== undefined ? { role: observed.identity.role } : {}),
      operator: observed.identity.operator,
    },
    agentSources: observed.agentSources,
    searchedAgentRoots: observed.searchedAgentRoots,
    ...(observed.markerProjectId !== undefined
      ? { markerProjectId: observed.markerProjectId }
      : {}),
    source: sourceStates(observed.source),
    resolution: {
      source: resolutionSource,
      ...(projectId !== undefined ? { projectId } : {}),
      ...(canonicalRoot !== undefined ? { canonicalRoot } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(worktreeBranch !== undefined ? { branch: worktreeBranch } : {}),
      reason,
    },
    warnings: [
      ...(worktreeWarning !== undefined ? [worktreeWarning] : []),
      ...(invalidWarning !== undefined ? [invalidWarning] : []),
    ],
    release: {
      releaseId: service.release.releaseId,
      sourceCommit: service.release.sourceCommit,
    },
  }
  return response
}

function sourceStates(
  source: Extract<AspcResolveRuntimeDeclarationResponse, { ok: true }>['source']
): ResolvePlacementResponse['source'] {
  return {
    agentProfile: source.agentProfile.state as DeclarationSourceState,
    projectTargets: source.projectTargets.state as DeclarationSourceState,
    selectedTarget: source.selectedTarget.state as DeclarationSourceState,
    priming: source.priming.state as DeclarationSourceState,
  }
}

export async function handleResolvePlacement(request: Request): Promise<Response> {
  return json(await resolvePlacementInProcess(parsePlacementBody(await parseJsonBody(request))))
}

/**
 * Daemon-side scope→placement resolution for in-process callers (kick-intent,
 * summon, locate): same policy + observation as the route, no self-HTTP.
 */
export async function resolvePlacementInProcess(
  body: ParsedPlacementInput,
  options: { env?: Record<string, string | undefined> | undefined } = {}
): Promise<ResolvePlacementResponse> {
  // The HTTP route always observes the daemon's own environment. In-process
  // callers (summon capability observer) may narrow discovery without
  // mutating process.env by passing their own env view.
  const env = options.env ?? process.env
  const agentsRoot = getAgentsRoot({ env: { ...env } })

  // Project identity: explicit input wins; otherwise marker inference from cwd
  // (HRC placement policy, vendored) — ASP_PROJECT env is deliberately not
  // consulted, matching inferProjectIdFromCwd's contract.
  const inferredProjectId =
    body.projectId === undefined ? inferProjectIdFromCwd({ cwd: body.cwd, env }) : undefined
  const projectId = body.projectId ?? inferredProjectId
  const projectExplicit = body.projectId !== undefined && body.projectOrigin !== 'inferred'

  // Canonical project root through HRC policy. Inferred/projectless scopes go
  // straight to aspd's infer-from-cwd walk; explicit scopes resolve the root
  // first (override → registry → marker scan → sibling fallback) so the
  // observation reads the same project the SDK resolved today.
  let canonicalRoot: string | undefined
  let canonicalSource:
    | 'explicit-override'
    | 'wrkq-registry'
    | 'marker-scan'
    | 'sibling-fallback'
    | undefined
  let worktreeBranch: string | undefined
  let worktreeWarning: string | undefined
  if (projectExplicit && projectId !== undefined) {
    try {
      const canonical = resolveCanonicalProjectRoot(projectId, {
        env,
        cwd: body.cwd,
        ...(body.registryProjects !== undefined ? { registryProjects: body.registryProjects } : {}),
        ...(body.projectSearchRoots !== undefined
          ? { projectSearchRoots: body.projectSearchRoots }
          : {}),
        ...(body.agentRootOverride !== undefined
          ? { agentRoot: body.agentRootOverride }
          : agentsRoot !== undefined
            ? { agentRoot: agentsRoot }
            : {}),
        ...(body.projectRootOverride !== undefined
          ? { projectRootOverride: body.projectRootOverride }
          : {}),
      })
      canonicalRoot = canonical.root
      canonicalSource = canonical.source
    } catch (error) {
      // An explicit override names the operator's intended checkout: a missing
      // override must fail closed, never silently remap to the registry root
      // (the observer reports it as checkout-missing with its real path).
      // resolveCanonicalProjectRoot only consults registry/marker/sibling via
      // canonical-checkout gating; the daemon registry helper additionally
      // honors directory-existence for cross-node registrations. Fall through
      // to the registry-existence candidate before failing.
      const explicitOverride = body.projectRootOverride ?? env['ASP_PROJECT_ROOT_OVERRIDE']
      const registered =
        explicitOverride === undefined
          ? resolveRegisteredProjectRoot(projectId, {
              env,
              ...(body.registryProjects !== undefined
                ? { registryProjects: body.registryProjects }
                : {}),
            })
          : undefined
      if (registered !== undefined) {
        canonicalRoot = registered
        canonicalSource = 'wrkq-registry'
      } else {
        const message = error instanceof Error ? error.message : String(error)
        throw new HrcUnprocessableEntityError(HrcErrorCode.DECLARATION_INVALID, message, {
          source: 'project-targets',
        })
      }
    }
    if (canonicalRoot !== undefined) {
      try {
        const worktree = refineTaskWorktree(canonicalRoot, body.taskId, { ...env })
        if (worktree !== undefined) {
          canonicalRoot = worktree.path
          worktreeBranch = worktree.branch
        }
      } catch (error) {
        if (body.taskWorktreeAssociation !== 'advisory') throw error
        const message = error instanceof Error ? error.message : String(error)
        worktreeWarning = `${message}; proceeding without task-worktree refinement`
      }
    }
  }

  const context: AspcRuntimeDeclarationContext = {
    agentId: body.agentId,
    ...(body.agentRootOverride !== undefined ? { agentRoot: body.agentRootOverride } : {}),
    project:
      canonicalRoot !== undefined
        ? {
            mode: 'root',
            projectRoot: canonicalRoot,
            ...(projectId !== undefined ? { projectId } : {}),
          }
        : { mode: 'infer-from-cwd' },
    cwd: body.cwd,
    runMode: body.runMode,
    ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
  }

  return await withAspdObservationSession(
    ['resolveRuntimeDeclaration'],
    async ({ service, client }) => {
      const declaration = await client.resolveRuntimeDeclaration({
        schemaVersion: 'aspc-resolve-runtime-declaration-request/v1',
        context,
      })
      if (!declaration.ok) {
        if ('resolution' in declaration && declaration.resolution.code === 'agent_not_found') {
          throw new HrcUnprocessableEntityError(
            HrcErrorCode.DECLARATION_INVALID,
            `agent "${body.agentId}" was not found (searched: ${declaration.searchedAgentRoots.join(', ') || 'no agent roots'})`,
            {
              source: 'agent-profile',
              producerCode: declaration.resolution.code,
              agentId: body.agentId,
              searchedAgentRoots: declaration.searchedAgentRoots,
              ...(canonicalRoot !== undefined ? { projectRoot: canonicalRoot } : {}),
              cwd: body.cwd,
            }
          )
        }
        const code =
          'resolution' in declaration ? declaration.resolution.code : declaration.failure.code
        const message =
          'resolution' in declaration ? declaration.resolution.message : declaration.failure.message
        throw new HrcUnprocessableEntityError(HrcErrorCode.DECLARATION_INVALID, message, {
          source: 'agent-profile',
          producerCode: code,
        })
      }

      const observed = declaration as Extract<AspcResolveRuntimeDeclarationResponse, { ok: true }>
      return assemblePlacementResponse(body, observed, service, {
        projectId,
        projectExplicit,
        canonicalRoot,
        canonicalSource,
        worktreeBranch,
        worktreeWarning,
      })
    }
  )
}
