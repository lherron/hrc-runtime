/**
 * T-08542 — HRC-hosted headless codex-app-server preparation through aspd with a
 * frozen execution release (docs/aspd-headless-codex-integration.md; invariants
 * hrc-runtime.aspd-prepared-execution-release and
 * hrc-runtime.asp-toolchain-selection).
 *
 * Two durable boundaries around the existing controller:
 *  - Boundary P (`prepareAspdHeadlessAttempt`): aspd compile → HRC admission →
 *    ONE transaction commits the complete response, execution release, launch
 *    description, dispatch env, lifecycle overlay and identity as a `prepared`
 *    runtime operation. No hosting effect precedes it.
 *  - Launch (`launchAspdPreparedAttempt`): takes only the operation id, rereads
 *    the row, validates the persisted bytes, then hands the frozen material to
 *    the controller, whose existing start graph (B4) moves the row to `starting`
 *    before invocation.start.
 *
 * Every v2 producer-selected execution, including terminal and native-worker
 * forms, crosses these same two boundaries. HRC validates the resource shape
 * and frozen release but never reselects a named driver route.
 */
import { randomUUID } from 'node:crypto'

import { HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
  PhaseRecorder,
} from 'hrc-core'
import { getAspHome } from 'hrc-core'
import type {
  AspcCompileHarnessInvocationResponse,
  AspcExecutionRelease,
} from 'spaces-aspc-protocol'
import type { BrokerLifecyclePolicyOverlay } from 'spaces-harness-broker-protocol'
import type { RuntimeCompileRequest, RuntimeIdentityAllocation } from 'spaces-runtime-contracts'
import type { BirthTimeline } from './birth-timeline.js'
import type { BrokerControllerStartInput } from './broker/controller/types.js'

import { actuatorSplitRuntimeAuthority, assertActuatorSplitAdmission } from './actuator-split.js'
import {
  ExecutionReleaseRefusal,
  buildAspdWorkerArgv,
  validateFrozenExecutionRelease,
} from './agent-spaces-adapter/aspd-execution-release.js'
import {
  type AspdPreparationResult,
  type AspdServiceIdentity,
  configuredAspdEndpoint,
  connectAspdUnix,
  prepareThroughAspd,
} from './agent-spaces-adapter/aspd-preparation-client.js'
import { buildHrcCorrelationEnv, mergeEnv } from './agent-spaces-adapter/cli-adapter.js'
import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import {
  type InteractiveTmuxBrokerDriver,
  extractPiSdkBrokerCredentialEnv,
  filterBrokerDispatchEnvForLockedEnv,
  toRuntimeContinuationRef,
} from './broker-decisions.js'
import {
  type BrokerSubstratePaths,
  describeBrokerSubstratePaths,
} from './broker-interactive-handlers/substrate-allocator.js'
import { projectBrokerRunExecution } from './broker-run-preview.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import type { SelectedExecution, SelectedExecutionPlan } from './broker/selected-execution.js'
import { buildManagedBrokerDispatchEnv } from './managed-broker-runtime-env.js'
import {
  type PrecompileLaunchTimingContext,
  createPrecompileLaunchTimingContext,
} from './precompile-launch-timing.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import {
  type AttachedRunObservation,
  type DispatchRunPersistenceOptions,
  dispatchRunPersistence,
} from './server-types.js'
import { timestamp } from './server-util.js'
import {
  automaticContinuationForSession,
  dropUnconfirmedResumeContinuation,
} from './session-continuation-reuse.js'
import { getBrokerObserverSocketPath } from './tmux-socket.js'
import { toBrokerResponseFormat } from './turn-response-format.js'

export const ASPD_PREPARATION_SCHEMA = 'hrc-aspd-preparation/v1'
type OkCompileResponse = Extract<AspcCompileHarnessInvocationResponse, { ok: true }>

/**
 * The routes a frozen aspd preparation launches on (T-08556 adds the interactive
 * Codex TUI; T-08562 adds the non-Codex interactive tmux broker route; the
 * headless muse-serve route admits that driver with presentation none or the
 * observer viewer).
 */
export type AspdPreparationRoute = 'producer-selected-execution'

/** The frozen preparation persisted in `runtime_operations.preparation_json`. */
export type AspdPreparationRecord = {
  schemaVersion: typeof ASPD_PREPARATION_SCHEMA
  route: AspdPreparationRoute
  preparedAt: string
  hostSessionId: string
  generation: number
  runtimeId: string
  runId: string
  operationId: string
  dispatchIdempotencyKey?: string | undefined
  aspd: AspdServiceIdentity
  /** The complete, unchanged successful compileHarnessInvocation response. */
  response: OkCompileResponse
  executionRelease: AspcExecutionRelease
  admission: {
    execution: SelectedExecution
    plan: SelectedExecutionPlan
    hrcPolicy: RuntimeCompileRequest['hrcPolicy']
    identity: RuntimeIdentityAllocation
  }
  hosting: {
    /** Producer-selected diagnostic key used only to name per-runtime paths. */
    driverKind: string
    /** A resource projection derived solely from the admitted execution. */
    presentation: AspdHostingPresentation
    executable: string
    argv: string[]
    paths: AspdHostingPaths
  }
  dispatch: {
    dispatchEnv?: Record<string, string> | undefined
    lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
    routeDecision: Record<string, unknown>
    runtimeAuthority?: Record<string, unknown> | undefined
    requestedResponseFormat?: ReturnType<typeof toBrokerResponseFormat>
  }
  intent: HrcRuntimeIntent
  startOutcome?: 'rejected' | 'uncertain' | undefined
}

type AspdHostingPresentation = 'none' | 'terminal' | 'attachable'

/** HRC's deterministic hosting paths; a viewer adds its observer socket. */
type AspdHostingPaths = BrokerSubstratePaths & { observerSocketPath?: string | undefined }

function describeAspdHostingPaths(
  options: HrcServerInstanceForHandlers['options'],
  driverKind: string,
  runtimeId: string,
  presentation: AspdHostingPresentation
): AspdHostingPaths {
  const paths = describeBrokerSubstratePaths(options, driverKind, runtimeId)
  return presentation === 'attachable'
    ? {
        ...paths,
        observerSocketPath: getBrokerObserverSocketPath(options, driverKind, runtimeId),
      }
    : paths
}

function aspdWorkerArgv(
  release: AspcExecutionRelease,
  record: Pick<AspdPreparationRecord, 'runtimeId' | 'hostSessionId' | 'generation'>,
  paths: AspdHostingPaths
): string[] {
  return buildAspdWorkerArgv(release, {
    socketPath: paths.brokerIpcSocketPath,
    eventLedgerPath: paths.eventLedgerPath,
    runtimeId: record.runtimeId,
    hostSessionId: record.hostSessionId,
    generation: record.generation,
    attachTokenPath: paths.attachTokenPath,
    ...(paths.observerSocketPath !== undefined
      ? { observerSocketPath: paths.observerSocketPath }
      : {}),
  })
}

/**
 * T-08556 (§1.4), T-08560 (§1.5.1), T-08562 (§1.6.2) — the interactive route:
 * every interactive broker birth, whichever door requests it, on a node that
 * declares an aspd endpoint. The named driver is a legacy door input, never
 * preparation authority.
 */
export function aspdInteractiveBrokerEndpoint(
  input: { allowedBrokerDriver: InteractiveTmuxBrokerDriver },
  env: Record<string, string | undefined> = process.env
): string | undefined {
  void input
  return configuredAspdEndpoint(env)
}

/** A retry never reselects a route; it names the single v2 preparation kind. */
export function aspdInteractiveRouteFor(_brokerDriver: string): AspdPreparationRoute {
  return 'producer-selected-execution'
}

function presentationForExecution(execution: SelectedExecution): AspdHostingPresentation {
  if (execution.hosting.terminalRequired) return 'terminal'
  return execution.presentationSurface?.transport === 'websocket-unix' ? 'attachable' : 'none'
}

/**
 * The route this module owns: the node declares an aspd endpoint and the intent
 * is ordinary headless codex-app-server, with operator presentation `none` or
 * the `tmux-tui` viewer, chosen by request or node default (T-08555), or
 * headless muse-serve with operator presentation `none`. Returns the endpoint,
 * or undefined for every other route.
 */
export function aspdHeadlessBrokerEndpoint(
  _intent: HrcRuntimeIntent,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  // The endpoint decides only service availability. Driver, terminal, and
  // presentation arrive after compile in the producer-selected execution.
  return configuredAspdEndpoint(env)
}

function aspdStartError(
  code: string,
  message: string,
  detail: Record<string, unknown>
): HrcRuntimeUnavailableError {
  return new HrcRuntimeUnavailableError(message, { code, route: 'aspd', ...detail })
}

function recordField(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined
}

/**
 * T-08713: the identity-bearing slice of a compile HRC refused, retained in the
 * refusal log for a post-hoc diff against HRC's allocation. Bounded: ids,
 * hashes, driver and hosting only; never argv, env, prompt or priming bytes.
 */
function summarizeRejectedCompile(response: unknown): Record<string, unknown> {
  const plan = recordField(response, 'plan')
  const execution = recordField(plan, 'execution')
  const startRequest = recordField(recordField(execution, 'dispatchRequest'), 'startRequest')
  const spec = recordField(startRequest, 'spec')
  const initialInput = recordField(startRequest, 'initialInput')
  return {
    planHash: recordField(plan, 'planHash'),
    compileId: recordField(plan, 'compileId'),
    agentId: recordField(recordField(plan, 'agent'), 'id'),
    planIdentity: recordField(plan, 'identity'),
    driver: recordField(execution, 'driver'),
    hosting: recordField(execution, 'hosting'),
    startRequestHash: recordField(recordField(execution, 'profile'), 'startRequestHash'),
    startRequest: {
      driver: recordField(recordField(spec, 'driver'), 'kind'),
      invocationId: recordField(spec, 'invocationId'),
      correlation: recordField(spec, 'correlation'),
      initialInputId: recordField(initialInput, 'inputId') ?? null,
    },
  }
}

/**
 * T-08560 (§1.5.1): the recorded door class of an interactive preparation. Only
 * the attached-run door carries an attach handshake.
 */
export type AspdInteractiveDoor = 'attached-run' | 'interactive-birth'

/** T-08560 (§1.5.3): how a launch-carried cold-birth prompt treats priming. */
export type AspdLaunchCarriedPromptMode = 'replace-priming' | 'append-to-priming'

/** T-08556: the interactive-route facts the start door decides before preparation. */
export type AspdInteractivePreparation = {
  flagEnvName: string
  /** T-08562: the driver the door requested; the admitted profile must equal it. */
  brokerDriver: InteractiveTmuxBrokerDriver
  continuation: ReturnType<typeof toRuntimeContinuationRef>
  door: AspdInteractiveDoor
  /**
   * T-08560 D1: a door's cold-birth prompt, compiled into this preparation
   * exactly as the facade compiles it and frozen only in the start request.
   */
  launchCarriedPrompt?: { prompt: string; mode: AspdLaunchCarriedPromptMode } | undefined
}

export type AspdPrepareInput = {
  session: HrcSessionRecord
  intent: HrcRuntimeIntent
  /** HRC-owned policy forwarded unchanged in the compile request and frozen at P. */
  policy?: RuntimeCompileRequest['hrcPolicy'] | undefined
  /** Present for the interactive route (§1.4); absent for the headless route. */
  interactive?: AspdInteractivePreparation | undefined
  /** Door-owned prompt carriage is frozen at compile, never used to select execution. */
  launchCarriedPrompt?: { prompt: string; mode: AspdLaunchCarriedPromptMode } | undefined
  preparedAuthority?: Parameters<typeof assertActuatorSplitAdmission>[0]['preparedAuthority']
  runId: string
  endpoint: string
  allowCompilerInitialInputWithoutIdentity?: boolean | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
  dispatchIdempotencyKey?: string | undefined
  timing?: PrecompileLaunchTimingContext | undefined
  birthTimeline?: BirthTimeline | undefined
  /** T-08708: the attached-run door's diagnostics sink; observational only. */
  observation?: AttachedRunObservation | undefined
}

/** Prepare through aspd and commit boundary P. Returns the prepared operation id. */
export async function prepareAspdHeadlessAttempt(
  server: HrcServerInstanceForHandlers,
  input: AspdPrepareInput
): Promise<string> {
  const { session, intent, runId, endpoint } = input
  const runtimeId = `rt-${randomUUID()}`
  const timing =
    input.timing ??
    createPrecompileLaunchTimingContext(
      input.interactive === undefined ? 'headless' : 'interactive',
      runtimeId,
      server.options.stateRoot
    )
  const hrcDispatchEnv = buildManagedBrokerDispatchEnv({
    baseEnv: mergeEnv(buildHrcCorrelationEnv(intent), intent.launch),
    db: server.db,
    runtimeRoot: server.options.runtimeRoot,
    hostSessionId: session.hostSessionId,
    runtimeId,
    mailStopSocket: server.options.socketPath,
  })

  let prepared: AspdPreparationResult | undefined
  const aspHome = getAspHome()
  // T-08560 D1: the facade's compile-only intent. The prompt reaches only the
  // frozen start request; `record.intent`, which the caller persists as the
  // applied intent, stays prompt-free.
  const launchCarriedPrompt = input.launchCarriedPrompt ?? input.interactive?.launchCarriedPrompt
  const compileIntent: HrcRuntimeIntent =
    launchCarriedPrompt !== undefined
      ? {
          ...intent,
          initialPrompt: launchCarriedPrompt.prompt,
          ...(launchCarriedPrompt.mode === 'append-to-priming' ? {} : { omitPriming: true }),
        }
      : intent
  const persistedIntent: HrcRuntimeIntent =
    launchCarriedPrompt === undefined
      ? intent
      : (() => {
          const {
            initialPrompt: _initialPrompt,
            omitPriming: _omitPriming,
            ...promptlessIntent
          } = intent
          return promptlessIntent
        })()
  input.birthTimeline?.mark('aspd-compile-begin')
  const observation = input.observation
  const compile = (phases: PhaseRecorder | undefined) =>
    compileBrokerRuntimePlan(
      {
        intent: compileIntent,
        scopeRef: session.scopeRef,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        dispatchEnv: hrcDispatchEnv,
        continuation:
          input.interactive !== undefined
            ? input.interactive.continuation
            : toRuntimeContinuationRef(automaticContinuationForSession(server.db, session)),
        ...(input.policy !== undefined ? { policy: input.policy } : {}),
        allowCompilerInitialInputWithoutIdentity: input.allowCompilerInitialInputWithoutIdentity,
        responseFormat: input.responseFormat,
      },
      {
        // T-08555: the worker's codex home hangs off ASP_HOME. Send HRC's own, the
        // one every other route (standalone codex-tui included) resolves, so a
        // continuation minted on either route resumes on the other instead of
        // depending on the aspd daemon's environment matching HRC's.
        compileHarnessInvocation: async (request) => {
          prepared = await prepareThroughAspd(
            endpoint,
            { ...request, aspHome },
            phases === undefined
              ? undefined
              : (options) => phases.step('aspd-connect', () => connectAspdUnix(options))
          )
          return prepared.response
        },
        timing,
        ids: {
          requestId: () => `req-${randomUUID()}`,
          operationId: () => `op-${randomUUID()}`,
          runtimeId: () => runtimeId,
          invocationId: () => `inv-${randomUUID()}`,
          initialInputId: () => `input-${randomUUID()}`,
          runId: () => runId,
          traceId: () => `trace-${randomUUID()}`,
        },
      }
    )
  const compiled =
    observation === undefined
      ? await compile(undefined)
      : await observation.phases.step('compile', compile)

  if (!compiled.admitted) {
    await observation?.phases
      .step('admission', () => {
        throw new Error(compiled.code)
      })
      .catch(() => undefined)
    // T-08713: an ASP compile failure (`compile-not-ok`) carries ASP's
    // diagnostics; HRC refusing a successful compile (`admission-rejected`)
    // carries HRC's own, naming the field that failed. The mail injector
    // classes both as definite pre-launch rejections.
    const hrcRefused = compiled.rejectedBy === 'hrc-admission'
    const detail = {
      rejectedBy: compiled.rejectedBy,
      hostSessionId: session.hostSessionId,
      runId,
      scopeRef: session.scopeRef,
      admissionCode: compiled.code,
      diagnostics:
        hrcRefused && compiled.admissionDiagnostic !== undefined
          ? [compiled.admissionDiagnostic, ...(compiled.diagnostics ?? [])]
          : compiled.diagnostics,
      endpoint,
      ...(prepared ? { aspdRelease: prepared.service.release } : {}),
    }
    writeServerLog('WARN', 'aspd.preparation.admission_rejected', {
      ...detail,
      ...(hrcRefused && prepared
        ? { rejectedCompile: summarizeRejectedCompile(prepared.response) }
        : {}),
    })
    throw hrcRefused
      ? aspdStartError(
          'admission-rejected',
          'aspd preparation refused by HRC admission (ASP compile succeeded)',
          detail
        )
      : aspdStartError('compile-not-ok', 'aspd preparation compile rejected by ASP', detail)
  }
  if (prepared === undefined || !prepared.response.ok) {
    throw aspdStartError('compile-not-ok', 'aspd preparation returned no successful response', {
      hostSessionId: session.hostSessionId,
      runId,
      endpoint,
    })
  }
  const response = prepared.response
  if (observation !== undefined) {
    await observation.phases.step('admission', () => undefined)
    observation.execution = projectBrokerRunExecution(compiled)
    observation.releases = {
      aspd: {
        releaseId: prepared.service.release.releaseId,
        sourceCommit: prepared.service.release.sourceCommit,
      },
      ...(response.executionRelease === undefined
        ? {}
        : {
            execution: {
              releaseId: response.executionRelease.releaseId,
              sourceCommit: response.executionRelease.sourceCommit,
            },
          }),
    }
  }
  input.birthTimeline?.enrich({
    runtimeId,
    operationId: String(compiled.identity.operationId),
    invocationId: String(compiled.identity.invocationId),
    compileId: String(compiled.plan.compileId),
    releaseId: prepared.service.release.releaseId,
    executionReleaseId: response.executionRelease?.releaseId,
  })
  input.birthTimeline?.mark('aspd-compile-admitted', {
    runtimeId,
    operationId: String(compiled.identity.operationId),
    invocationId: String(compiled.identity.invocationId),
    compileId: String(compiled.plan.compileId),
    releaseId: prepared.service.release.releaseId,
  })
  input.birthTimeline?.mark('launch-carried-input-compiled', {
    initialInputId: String(compiled.identity.initialInputId),
    launchCarried: compileIntent.initialPrompt !== undefined,
  })
  const release = response.executionRelease
  if (release === undefined) {
    throw aspdStartError(
      'execution_release_missing',
      'aspd preparation carries no executionRelease; refusing without fallback',
      {
        hostSessionId: session.hostSessionId,
        runId,
        endpoint,
        aspdRelease: prepared.service.release,
      }
    )
  }
  const interactive = input.interactive
  const actuatorSplitAuthority = await assertActuatorSplitAdmission({
    intent: persistedIntent,
    route: interactive === undefined ? 'broker' : 'interactive-broker',
    startRequest: compiled.execution.dispatchRequest.startRequest,
    preparedAuthority: input.preparedAuthority,
  })

  const mergedDispatchEnv = {
    ...(compiled.execution.dispatchRequest.dispatchEnv ?? {}),
    ...hrcDispatchEnv,
  }
  if (
    extractPiSdkBrokerCredentialEnv(
      mergedDispatchEnv,
      compiled.execution.dispatchRequest.startRequest
    ) !== undefined
  ) {
    // Broker-process credentials are never persisted; this route carries none.
    throw aspdStartError(
      'aspd_route_profile_mismatch',
      'aspd-prepared route cannot carry broker credential env',
      { hostSessionId: session.hostSessionId, runId }
    )
  }
  const dispatchEnv = filterBrokerDispatchEnvForLockedEnv(
    mergedDispatchEnv,
    compiled.execution.dispatchRequest.startRequest
  )
  const lifecyclePolicy = resolveLifecyclePolicyOverlay({
    routeId: `${interactive === undefined ? 'headless-broker' : 'interactive-broker'}:${compiled.execution.driver}`,
    brokerRoute: true,
  })
  const operationId = String(compiled.identity.operationId)
  const brokerDriver = compiled.execution.driver
  const route: AspdPreparationRoute = 'producer-selected-execution'
  const presentation = presentationForExecution(compiled.execution)
  input.birthTimeline?.enrich({ presentation })
  const paths = describeAspdHostingPaths(server.options, brokerDriver, runtimeId, presentation)
  const argv = aspdWorkerArgv(
    release,
    { runtimeId, hostSessionId: session.hostSessionId, generation: session.generation },
    paths
  )
  const runtimeAuthority = actuatorSplitRuntimeAuthority(actuatorSplitAuthority)
  const requestedResponseFormat = toBrokerResponseFormat(input.responseFormat)
  const preparedAt = timestamp()
  input.birthTimeline?.mark('aspd-preparation-commit', {
    runtimeId,
    operationId,
    invocationId: String(compiled.identity.invocationId),
    compileId: String(compiled.plan.compileId),
    releaseId: release.releaseId,
  })
  const aspdRouteDecision = {
    preparation: 'aspd',
    aspdEndpoint: endpoint,
    aspdRelease: prepared.service.release,
    executionReleaseId: release.releaseId,
    // T-08555: the ASP_HOME the worker's codex home was compiled under.
    aspHome,
  }
  const routeDecision: Record<string, unknown> =
    interactive === undefined
      ? {
          route: 'broker',
          selectedBy: 'producer-selected-execution',
          headlessRoute: 'durable-leased',
          brokerTransport: 'unix-jsonrpc-ndjson',
          hostingPresentation: presentation,
          ...(launchCarriedPrompt !== undefined
            ? { launchCarriedPrompt: { mode: launchCarriedPrompt.mode } }
            : {}),
          ...aspdRouteDecision,
        }
      : {
          // T-08556 (§1.4), T-08560 (§1.5), T-08562 (§1.6): an interactive birth by any door.
          route: 'broker',
          flag: interactive.flagEnvName,
          selectedBy: 'producer-selected-execution',
          durableInteractiveRoute: 'producer-selected-execution',
          brokerTransport: 'unix-jsonrpc-ndjson',
          durableRouteSelectedBy: 'decideBrokerDurableInteractiveRoute',
          door: interactive.door,
          ...(launchCarriedPrompt !== undefined
            ? { launchCarriedPrompt: { mode: launchCarriedPrompt.mode } }
            : {}),
          ...aspdRouteDecision,
        }
  const record: AspdPreparationRecord = {
    schemaVersion: ASPD_PREPARATION_SCHEMA,
    route,
    preparedAt,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId,
    runId,
    operationId,
    ...(input.dispatchIdempotencyKey !== undefined
      ? { dispatchIdempotencyKey: input.dispatchIdempotencyKey }
      : {}),
    aspd: prepared.service,
    response,
    executionRelease: release,
    admission: {
      plan: compiled.plan,
      execution: compiled.execution,
      hrcPolicy: compiled.hrcPolicy,
      identity: compiled.identity,
    },
    hosting: {
      driverKind: brokerDriver,
      presentation,
      executable: release.worker.executable,
      argv,
      paths,
    },
    dispatch: {
      ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
      ...(lifecyclePolicy !== undefined ? { lifecyclePolicy } : {}),
      routeDecision,
      ...(runtimeAuthority !== undefined ? { runtimeAuthority } : {}),
      ...(requestedResponseFormat !== undefined ? { requestedResponseFormat } : {}),
    },
    intent: persistedIntent,
  }

  // Boundary P: one transaction, before any hosting effect.
  server.db.sqlite.transaction(() => {
    server.db.compiledRuntimePlans.insert({
      planHash: String(compiled.plan.planHash),
      compileId: String(compiled.plan.compileId),
      schemaVersion: compiled.plan.schemaVersion,
      compilerName: 'aspc',
      compilerVersion: 'v2',
      planProjectionJson: JSON.stringify(compiled.plan),
      diagnosticsJson: JSON.stringify(compiled.plan.diagnostics ?? []),
      createdAt: compiled.plan.createdAt,
    })
    server.db.runtimeOperations.insert({
      operationId,
      runtimeId,
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      operationKind: 'broker_invocation',
      controller: 'harness-broker',
      compileId: String(compiled.plan.compileId),
      planHash: String(compiled.plan.planHash),
      selectedProfileId: String(compiled.execution.profile.profileId),
      selectedProfileHash: String(compiled.execution.profile.profileHash),
      startupMethod: 'broker.startInvocationFromRequest',
      turnDelivery: 'invocation.input',
      status: 'prepared',
      routeDecisionJson: JSON.stringify(record.dispatch.routeDecision),
      preparationJson: JSON.stringify(record),
      createdAt: preparedAt,
      updatedAt: preparedAt,
    })
  })()
  writeServerLog('INFO', 'aspd.preparation.frozen', {
    route: record.route,
    operationId,
    runtimeId,
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    aspdRelease: prepared.service.release.releaseId,
    executionRelease: release.releaseId,
    dispatchIdempotencyKey: input.dispatchIdempotencyKey,
  })
  return operationId
}

/** Read and parse a prepared operation's frozen record from the database. */
export function readAspdPreparation(
  server: Pick<HrcServerInstanceForHandlers, 'db'>,
  operationId: string
): { status: string; record: AspdPreparationRecord } {
  const operation = server.db.runtimeOperations.getByOperationId(operationId)
  if (operation?.preparationJson === undefined) {
    throw aspdStartError('aspd_preparation_missing', `no aspd preparation ${operationId}`, {
      operationId,
    })
  }
  const record = JSON.parse(operation.preparationJson) as AspdPreparationRecord
  if (record.schemaVersion !== ASPD_PREPARATION_SCHEMA || record.operationId !== operationId) {
    throw aspdStartError('aspd_preparation_invalid', `aspd preparation ${operationId} is invalid`, {
      operationId,
      schemaVersion: record.schemaVersion,
    })
  }
  return { status: operation.status, record }
}

/**
 * T-08560 D2 route fence: a resume branch launches only a preparation frozen on
 * its own route. A same-key retry whose session routing now selects the other
 * route is refused retryably and the preparation stays `prepared`; preparing
 * anew would rebind a committed attempt to the active release (§5).
 */
export function assertPreparedAspdAttemptRoute(
  resumable: {
    operationId: string
    runId: string
    route: AspdPreparationRoute
    driverKind: string
  },
  selected: { route: AspdPreparationRoute; driverKind: string },
  hostSessionId: string
): void {
  // v2 has one producer-selected preparation kind. A retry must never turn a
  // diagnostic driver string into a second HRC route or selection decision.
  if (resumable.route === selected.route) return
  throw aspdStartError(
    'aspd_preparation_route_changed',
    `the frozen aspd preparation is ${resumable.route}; this retry selected ${selected.route}`,
    {
      reason: 'aspd_preparation_route_changed',
      operationId: resumable.operationId,
      runId: resumable.runId,
      hostSessionId,
      frozenRoute: resumable.route,
      selectedRoute: selected.route,
      // Retained as diagnostic evidence only; neither value selects hosting.
      frozenDriver: resumable.driverKind,
      selectedDriver: selected.driverKind,
    }
  )
}

/**
 * The never-submitted preparation a same-key caller retry resumes, if any.
 * Status `prepared` is the only resumable state.
 */
export function findPreparedAspdAttemptForRetry(
  server: Pick<HrcServerInstanceForHandlers, 'db'>,
  hostSessionId: string,
  dispatchIdempotencyKey: string
):
  | { operationId: string; runId: string; route: AspdPreparationRoute; driverKind: string }
  | undefined {
  for (const operation of server.db.runtimeOperations.listPreparedByHostSession(hostSessionId)) {
    if (operation.preparationJson === undefined) continue
    try {
      const record = JSON.parse(operation.preparationJson) as AspdPreparationRecord
      if (
        record.schemaVersion === ASPD_PREPARATION_SCHEMA &&
        record.dispatchIdempotencyKey === dispatchIdempotencyKey
      ) {
        return {
          operationId: operation.operationId,
          runId: record.runId,
          route: record.route,
          driverKind: record.hosting.driverKind,
        }
      }
    } catch {
      // An unreadable row is not a match; launch will name it if addressed directly.
    }
  }
  return undefined
}

function recordPrelaunchRefusal(
  server: Pick<HrcServerInstanceForHandlers, 'db'>,
  operationId: string,
  code: string,
  message: string
): void {
  const current = server.db.runtimeOperations.getByOperationId(operationId)
  if (current?.status !== 'prepared') return
  server.db.runtimeOperations.update(operationId, {
    errorCode: code,
    errorMessage: message,
    updatedAt: timestamp(),
  })
}

export type AspdLaunchOptions = DispatchRunPersistenceOptions & {
  onAccepted?: ((runtime: HrcRuntimeSnapshot) => Promise<void> | void) | undefined
  /**
   * T-08556: the attached-run door's live attach handshake. Not frozen: it names
   * this process's pending attach, which a preparation cannot outlive.
   */
  attachBeforeInvocationStart?: BrokerControllerStartInput['attachBeforeInvocationStart']
  birthTimeline?: BirthTimeline | undefined
  settleFailure: (error: {
    code: string
    message: string
    detail: Record<string, unknown>
  }) => never
}

/**
 * Launch a frozen aspd preparation. Input is only the operation id: every fact
 * is reread from the database. Pre-start refusals leave the row `prepared`
 * with the refusal recorded; nothing is re-prepared or rebound.
 */
export async function launchAspdPreparedAttempt(
  server: HrcServerInstanceForHandlers,
  operationId: string,
  options: AspdLaunchOptions
): Promise<{ runtime: HrcRuntimeSnapshot; intent: HrcRuntimeIntent }> {
  const { status, record } = readAspdPreparation(server, operationId)
  options.birthTimeline?.enrich({
    runtimeId: record.runtimeId,
    operationId,
    invocationId: String(record.admission.identity.invocationId),
    compileId: String(record.admission.plan.compileId),
    releaseId: record.aspd.release.releaseId,
    executionReleaseId: record.executionRelease.releaseId,
    presentation: record.hosting.presentation,
  })
  options.birthTimeline?.mark('aspd-prepared-attempt-read', { operationId })
  const detail = {
    operationId,
    runtimeId: record.runtimeId,
    runId: record.runId,
    hostSessionId: record.hostSessionId,
    executionReleaseId: record.executionRelease.releaseId,
  }
  if (status !== 'prepared') {
    throw aspdStartError(
      'aspd_preparation_not_prepared',
      `aspd preparation ${operationId} is ${status}, not a never-submitted prepared attempt`,
      { ...detail, status }
    )
  }
  const refuse = (code: string, message: string, extra: Record<string, unknown> = {}): never => {
    recordPrelaunchRefusal(server, operationId, code, message)
    writeServerLog('WARN', 'aspd.launch.refused', { code, ...detail, ...extra })
    throw aspdStartError(code, message, { ...detail, ...extra })
  }

  const session = server.db.sessions.getByHostSessionId(record.hostSessionId)
  if (session === null || session.generation !== record.generation) {
    refuse(
      'preparation_generation_superseded',
      'the host session generation moved past this frozen preparation',
      { frozenGeneration: record.generation, currentGeneration: session?.generation }
    )
  }

  let executable: string
  try {
    executable = validateFrozenExecutionRelease(record.executionRelease).executable
  } catch (error) {
    if (error instanceof ExecutionReleaseRefusal) {
      return refuse(error.code, error.message, error.detail)
    }
    throw error
  }
  const currentPaths = describeAspdHostingPaths(
    server.options,
    record.hosting.driverKind,
    record.runtimeId,
    record.hosting.presentation
  )
  const expectedArgv = aspdWorkerArgv(record.executionRelease, record, currentPaths)
  const launchMatchesAdmission =
    record.route === 'producer-selected-execution' &&
    record.hosting.driverKind === record.admission.execution.driver &&
    record.hosting.presentation === presentationForExecution(record.admission.execution)
  if (
    JSON.stringify(expectedArgv) !== JSON.stringify(record.hosting.argv) ||
    JSON.stringify(currentPaths) !== JSON.stringify(record.hosting.paths) ||
    !launchMatchesAdmission
  ) {
    refuse('launch_description_mismatch', 'frozen worker launch description no longer matches', {
      frozenArgv: record.hosting.argv,
    })
  }

  writeServerLog('INFO', 'aspd.launch.begin', { ...detail, executable })
  options.birthTimeline?.mark('aspd-launch-authority-validated', detail)
  const controller = server.getHarnessBrokerController()
  const admission = record.admission
  const result = await controller.start({
    execution: admission.execution,
    plan: admission.plan,
    hrcPolicy: admission.hrcPolicy,
    identity: admission.identity,
    ...(options.birthTimeline !== undefined ? { birthTimeline: options.birthTimeline } : {}),
    ...(record.dispatch.runtimeAuthority !== undefined
      ? { runtimeAuthority: record.dispatch.runtimeAuthority }
      : {}),
    ...(record.dispatch.requestedResponseFormat !== undefined
      ? { requestedResponseFormat: record.dispatch.requestedResponseFormat }
      : {}),
    ...dispatchRunPersistence(options),
    dispatchEnv: record.dispatch.dispatchEnv,
    routeDecision: record.dispatch.routeDecision,
    ...(record.dispatch.lifecyclePolicy !== undefined
      ? { lifecyclePolicy: record.dispatch.lifecyclePolicy }
      : {}),
    ...(options.attachBeforeInvocationStart !== undefined
      ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
      : {}),
    aspdExecution: {
      operationId,
      release: record.executionRelease,
      executable,
      argv: record.hosting.argv,
    },
    ...(options.onAccepted
      ? {
          onAccepted: async (graph) => {
            await options.onAccepted?.(graph.runtime)
          },
        }
      : {}),
  })
  if (!result.ok) {
    recordPrelaunchRefusal(server, operationId, result.error.code, result.error.message)
    writeServerLog('WARN', 'aspd.launch.failed', { code: result.error.code, ...detail })
    const resumeFailure = dropUnconfirmedResumeContinuation(server.db, {
      invocationId: String(record.admission.identity.invocationId),
      stage: 'start',
      failure: result.error.message,
    })
    if (resumeFailure?.event !== undefined) server.notifyEvent(resumeFailure.event)
    options.settleFailure(
      resumeFailure === undefined
        ? result.error
        : {
            ...result.error,
            message: `${resumeFailure.message} (${result.error.message})`,
            detail: {
              ...result.error.detail,
              resumeFailedAtLaunch: {
                provider: resumeFailure.provider,
                continuationKey: resumeFailure.key,
                dropped: resumeFailure.dropped,
              },
            },
          }
    )
  }
  writeServerLog('INFO', 'aspd.launch.started', {
    ...detail,
    invocationId: result.invocation.invocationId,
    workerRelease: result.hello.release?.releaseId,
  })
  return { runtime: result.runtime, intent: record.intent }
}
