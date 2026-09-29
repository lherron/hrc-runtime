import type { HarnessInvocationSpec, InvocationStartRequest } from 'spaces-harness-broker-protocol'
import { type RuntimeIdentityAllocation, neutralStartRequestHash } from 'spaces-runtime-contracts'

import { agentName, agentSources, bundleRef, projectRoot } from './aspd-observation-context'
import type { AspdObservationOptions, PromptScript } from './aspd-observation-types'
import type { Release } from './aspd-route-doubles'

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
      agentProfile: {
        state: 'valid',
        code: 'parsed',
        contentHash: 'sha256:agent-profile',
      },
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
      {
        kind: 'runtime-plan',
        sourceId: 'canonical-compile',
        sourceRef: 'agent-runtime-plan/v1',
      },
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
        value: {
          zone: 'prompt',
          name: 'template:resolution',
          sourceType: 'inline',
          order: 0,
        },
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
        value: {
          family: 'claude-code',
          runtime: 'claude-code-cli',
          provider: 'anthropic',
        },
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
        value: {
          artifactKind: 'bundle',
          bundleIdentity: 'bundle:t08564-inspection',
        },
      },
      {
        kind: 'execution-profile',
        partId: 'execution-profile:profile_t08564',
        disposition: effective,
        provenance: contribution,
        value: {
          profileId: 'profile_t08564',
          controllerKind: 'harness-broker',
        },
      },
    ],
    completeness: {
      kind: 'partial',
      missingPartIds: ['prompt:template:resolution'],
    },
    freshness: {
      kind: 'unknown',
      reason: 'The canonical compile produced no lock hash',
    },
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
export function inspectNonOkResponse(): Record<string, unknown> {
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
 * Preview compiler double. It emits the same singular v2 execution envelope
 * that ordinary compilation admits; no v1 profile list is retained here.
 */
export function compileResponse(params: Record<string, unknown>, serving: Release) {
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
    harness: {
      frontend: 'codex',
      provider: 'openai',
      driver: 'codex-app-server',
    },
    process: {
      command: '/Users/lherron/.local/bin/codex',
      args: ['--enable', 'goals', 'app-server'],
      cwd,
      lockedEnv,
      harnessTransport: { kind: 'jsonrpc-stdio' },
      limits: {
        startupTimeoutMs: 20_000,
        turnTimeoutMs: 900_000,
        stopGraceMs: 5_000,
      },
    },
    interaction: {
      mode: 'headless',
      turnConcurrency: 'single',
      inputQueue: 'fifo',
    },
    driver: {
      kind: 'codex-app-server',
      approvalPolicy: 'never',
      permissionPolicy: { mode: 'deny' },
      resumeFallback: 'fail',
    },
    correlation,
  }
  const startRequest: InvocationStartRequest = { spec }
  return {
    schemaVersion: 'aspc-compile-harness-invocation-response/v2',
    ok: true,
    diagnostics: [],
    plan: {
      schemaVersion: 'agent-runtime-plan/v2',
      agent: compileRequest['agent'],
      identity,
      compileId: 'compile_t08564',
      planHash: 'planhash_t08564',
      createdAt: '2026-09-17T07:51:25.901Z',
      diagnostics: [],
      selection: {
        harness: 'agent-harness',
        modelProvider: 'openai-codex',
        model: 'gpt-5.5',
        presentation: false,
        provenance: {
          harness: 'catalog-default',
          modelProvider: 'catalog-default',
          model: 'catalog-default',
          presentation: 'catalog-default',
        },
      },
      execution: {
        recipeId: 'fixture-codex-app-server',
        driver: 'codex-app-server',
        protocol: 'harness-broker/0.2',
        hosting: {
          executionTransport: 'jsonrpc-stdio',
          terminalRequired: false,
          processExecution: 'broker-process',
        },
        presentationFulfillment: 'attachable',
        profile: {
          profileId: 'profile_t08564',
          profileHash: 'profilehash_t08564',
          compatibilityHash: 'compat_t08564',
          startRequestHash: neutralStartRequestHash(startRequest),
        },
        dispatchRequest: { startRequest },
      },
    },
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
export function helloResponse(
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
export function capabilityResponse(params: Record<string, unknown>): Record<string, unknown> {
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
export function inspectResponse(
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
