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
 * T-08556 (§1.4): the same two boundaries also carry the interactive
 * codex-app-server + codexTui birth of the attached-run door (`hrc run`,
 * `hrc resume`), frozen as route `interactive-codex-tui`. T-08560 (§1.5): every
 * door's interactive codex-app-server birth takes that route, with its door
 * class and any launch-carried cold-birth prompt frozen at boundary P.
 *
 * T-08562 (§1.6): every claude-code-tmux and pi-tui-tmux interactive birth takes
 * the same boundaries as route `interactive-tmux-broker`, admitted by hosting
 * shape plus equality with the requested driver, and launched only when the
 * frozen execution release carries positive hosting evidence for that driver.
 */
import { randomUUID } from 'node:crypto'

import { HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import { getAspHome } from 'hrc-core'
import type {
  AspcCompileHarnessInvocationResponse,
  AspcExecutionRelease,
} from 'spaces-aspc-protocol'
import type {
  BrokerLifecyclePolicyOverlay,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CompiledRuntimePlan,
  RuntimeIdentityAllocation,
} from 'spaces-runtime-contracts'
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
  prepareThroughAspd,
} from './agent-spaces-adapter/aspd-preparation-client.js'
import { buildHrcCorrelationEnv, mergeEnv } from './agent-spaces-adapter/cli-adapter.js'
import {
  compileBrokerRuntimePlan,
  toProfileSelector,
} from './agent-spaces-adapter/compile-adapter.js'
import { isInteractiveTmuxBrokerProfile } from './agent-spaces-adapter/compile-profile-selector.js'
import {
  type InteractiveTmuxBrokerDriver,
  decideCodexAppServerPresentation,
  decideInteractiveTmuxExecutionRoute,
  decideMuseServePresentation,
  extractPiSdkBrokerCredentialEnv,
  filterBrokerDispatchEnvForLockedEnv,
  toRuntimeContinuationRef,
} from './broker-decisions.js'
import {
  type BrokerSubstratePaths,
  describeBrokerSubstratePaths,
} from './broker-interactive-handlers/substrate-allocator.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import { buildManagedBrokerDispatchEnv } from './managed-broker-runtime-env.js'
import type { PrecompileLaunchTimingContext } from './precompile-launch-timing.js'
import { operatorPresentationSource } from './presentation-operator.js'
import {
  HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION_ENV,
  HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
  HRC_HEADLESS_MUSE_BROKER_ENABLED_ENV,
  HRC_MUSE_SERVE_OPERATOR_PRESENTATION_ENV,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { type DispatchRunPersistenceOptions, dispatchRunPersistence } from './server-types.js'
import { timestamp } from './server-util.js'
import { automaticContinuationForSession } from './session-continuation-reuse.js'
import { getBrokerObserverSocketPath } from './tmux-socket.js'
import { toBrokerResponseFormat } from './turn-response-format.js'

export const ASPD_PREPARATION_SCHEMA = 'hrc-aspd-preparation/v1'
const ASPD_BROKER_DRIVER = 'codex-app-server'
const ASPD_MUSE_BROKER_DRIVER = 'muse-serve'

type OkCompileResponse = Extract<AspcCompileHarnessInvocationResponse, { ok: true }>

/**
 * The routes a frozen aspd preparation launches on (T-08556 adds the interactive
 * Codex TUI; T-08562 adds the non-Codex interactive tmux broker route; the
 * headless muse-serve route admits that driver with presentation none or the
 * observer viewer).
 */
export type AspdPreparationRoute =
  | 'headless-codex-app-server'
  | 'headless-muse-serve'
  | 'interactive-codex-tui'
  | 'interactive-tmux-broker'

/**
 * T-08562 (§1.6.2): the one named deprecation fence. `codex-cli-tmux` keeps its
 * current (facade) path; it has no release binding and no door emits it.
 */
const ASPD_DEPRECATED_INTERACTIVE_DRIVER = 'codex-cli-tmux'

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
    plan: CompiledRuntimePlan
    profile: BrokerExecutionProfile
    startRequest: InvocationStartRequest
    specHash: string
    startRequestHash: string
    identity: RuntimeIdentityAllocation
  }
  hosting: {
    /**
     * The admitted broker driver: `codex-app-server` on the Codex routes; the
     * admitted `claude-code-tmux` or `pi-tui-tmux` on `interactive-tmux-broker`
     * (T-08562). HRC's hosting paths are keyed on it.
     */
    driverKind: string
    /**
     * `none` or the `tmux-tui` viewer (T-08553–T-08555) on the headless route;
     * `codex-tui`, the leased interactive TUI pane, on the interactive Codex route
     * (T-08556); `interactive-tui`, the leased TUI pane of a non-Codex driver, on
     * `interactive-tmux-broker` (T-08562).
     */
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

/**
 * The presentations the headless route hosts: ordinary headless (`none`), the
 * codex tmux-tui viewer, and the muse-serve observer viewer. T-08542:
 * refusing anything else is deliberate.
 */
type AspdHostingPresentation = 'none' | 'tmux-tui' | 'codex-tui' | 'interactive-tui' | 'observer'

/** HRC's deterministic hosting paths; a viewer adds its observer socket. */
type AspdHostingPaths = BrokerSubstratePaths & { observerSocketPath?: string | undefined }

/**
 * The operator presentation this route hosts for an intent, or undefined when
 * the intent is not on this route: effective `none` or `tmux-tui`, from an
 * explicit request (T-08553/T-08554) or the node default (T-08555, §1.3
 * decision 2).
 */
function aspdRoutePresentation(
  intent: HrcRuntimeIntent,
  env: Record<string, string | undefined>
): AspdHostingPresentation | undefined {
  if (intent.harness.interactive === true) return undefined
  const brokerDriver = toProfileSelector(intent)?.brokerDriver
  if (brokerDriver === ASPD_MUSE_BROKER_DRIVER) {
    // The observer viewer is hosted on this route (observer pane + socket;
    // the driver launches its renderer there), so the decision stands as-is.
    return decideMuseServePresentation({
      operatorPresentation: env[HRC_MUSE_SERVE_OPERATOR_PRESENTATION_ENV],
      brokerDriver,
      requestedOperator: intent.presentation?.operator,
    })
  }
  if (brokerDriver !== ASPD_BROKER_DRIVER) return undefined
  const decided = decideCodexAppServerPresentation({
    operatorPresentation: env[HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION_ENV],
    brokerDriver: ASPD_BROKER_DRIVER,
    requestedOperator: intent.presentation?.operator,
  })
  // The codex decider never selects the muse-serve 'observer' viewer; narrow
  // the widened OperatorPresentation back to the aspd hosting union.
  return decided === 'observer' ? 'none' : decided
}

function describeAspdHostingPaths(
  options: HrcServerInstanceForHandlers['options'],
  driverKind: string,
  runtimeId: string,
  presentation: AspdHostingPresentation
): AspdHostingPaths {
  const paths = describeBrokerSubstratePaths(options, driverKind, runtimeId)
  return presentation === 'tmux-tui' || presentation === 'observer'
    ? {
        ...paths,
        observerSocketPath: getBrokerObserverSocketPath(options, driverKind, runtimeId),
      }
    : paths
}

/**
 * T-08562 (§1.6.3): the positive hosting evidence a frozen release carries for
 * its worker, read from the optional `executionRelease.worker.hostedDrivers`
 * (untyped in HRC's locked protocol; the thin client passes the result through).
 * A malformed value is treated as absent.
 */
function hostedDriversOf(release: AspcExecutionRelease): string[] | undefined {
  const value = (release.worker as { hostedDrivers?: unknown }).hostedDrivers
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : undefined
}

/**
 * T-08562 (§1.6.3): any driver other than codex-app-server launches on the aspd
 * route only when the frozen release lists it in `hostedDrivers`. codex-app-server
 * is exempt: its binding is already proven, so retained releases keep serving it.
 */
function workerHostingUnproven(
  release: AspcExecutionRelease,
  brokerDriver: string
): { hostedDrivers: string[] | null } | undefined {
  if (brokerDriver === ASPD_BROKER_DRIVER) return undefined
  const hostedDrivers = hostedDriversOf(release)
  return hostedDrivers?.includes(brokerDriver) === true
    ? undefined
    : { hostedDrivers: hostedDrivers ?? null }
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
 * declares an aspd endpoint. Returns the endpoint, or undefined for an
 * unconfigured node and for the deprecated `codex-cli-tmux` fence.
 */
export function aspdInteractiveBrokerEndpoint(
  input: { allowedBrokerDriver: InteractiveTmuxBrokerDriver },
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (input.allowedBrokerDriver === ASPD_DEPRECATED_INTERACTIVE_DRIVER) return undefined
  return configuredAspdEndpoint(env)
}

/** T-08562: the frozen interactive route an admitted driver launches on. */
export function aspdInteractiveRouteFor(brokerDriver: string): AspdPreparationRoute {
  return brokerDriver === ASPD_BROKER_DRIVER ? 'interactive-codex-tui' : 'interactive-tmux-broker'
}

/**
 * The route this module owns: the node declares an aspd endpoint and the intent
 * is ordinary headless codex-app-server, with operator presentation `none` or
 * the `tmux-tui` viewer, chosen by request or node default (T-08555), or
 * headless muse-serve with operator presentation `none`. Returns the endpoint,
 * or undefined for every other route.
 */
export function aspdHeadlessBrokerEndpoint(
  intent: HrcRuntimeIntent,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (aspdRoutePresentation(intent, env) === undefined) return undefined
  return configuredAspdEndpoint(env)
}

function aspdStartError(
  code: string,
  message: string,
  detail: Record<string, unknown>
): HrcRuntimeUnavailableError {
  return new HrcRuntimeUnavailableError(message, { code, route: 'aspd', ...detail })
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
  /** Present for the interactive route (§1.4); absent for the headless route. */
  interactive?: AspdInteractivePreparation | undefined
  preparedAuthority?: Parameters<typeof assertActuatorSplitAdmission>[0]['preparedAuthority']
  runId: string
  endpoint: string
  allowCompilerInitialInputWithoutIdentity?: boolean | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
  dispatchIdempotencyKey?: string | undefined
  timing?: PrecompileLaunchTimingContext | undefined
  birthTimeline?: BirthTimeline | undefined
}

/** Prepare through aspd and commit boundary P. Returns the prepared operation id. */
export async function prepareAspdHeadlessAttempt(
  server: HrcServerInstanceForHandlers,
  input: AspdPrepareInput
): Promise<string> {
  const { session, intent, runId, endpoint } = input
  const runtimeId = `rt-${randomUUID()}`
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
  const launchCarriedPrompt = input.interactive?.launchCarriedPrompt
  const compileIntent: HrcRuntimeIntent =
    launchCarriedPrompt !== undefined
      ? {
          ...intent,
          initialPrompt: launchCarriedPrompt.prompt,
          ...(launchCarriedPrompt.mode === 'append-to-priming' ? {} : { omitPriming: true }),
        }
      : intent
  input.birthTimeline?.mark('aspd-compile-begin')
  const compiled = await compileBrokerRuntimePlan(
    {
      intent: compileIntent,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      dispatchEnv: hrcDispatchEnv,
      continuation:
        input.interactive !== undefined
          ? input.interactive.continuation
          : toRuntimeContinuationRef(automaticContinuationForSession(server.db, session)),
      allowCompilerInitialInputWithoutIdentity: input.allowCompilerInitialInputWithoutIdentity,
      responseFormat: input.responseFormat,
    },
    {
      // T-08555: the worker's codex home hangs off ASP_HOME. Send HRC's own, the
      // one every other route (standalone codex-tui included) resolves, so a
      // continuation minted on either route resumes on the other instead of
      // depending on the aspd daemon's environment matching HRC's.
      compileHarnessInvocation: async (request) => {
        prepared = await prepareThroughAspd(endpoint, { ...request, aspHome })
        return prepared.response
      },
      ...(input.timing ? { timing: input.timing } : {}),
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

  if (!compiled.admitted) {
    throw aspdStartError('compile-not-ok', 'aspd preparation compile/admission rejected', {
      hostSessionId: session.hostSessionId,
      runId,
      admissionCode: compiled.code,
      diagnostics: compiled.diagnostics,
      endpoint,
      ...(prepared ? { aspdRelease: prepared.service.release } : {}),
    })
  }
  if (prepared === undefined || !prepared.response.ok) {
    throw aspdStartError('compile-not-ok', 'aspd preparation returned no successful response', {
      hostSessionId: session.hostSessionId,
      runId,
      endpoint,
    })
  }
  const response = prepared.response
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
  // T-08562 (§1.6.3): an interactive preparation is admitted by hosting shape
  // (interactive, supported protocol, tmux terminal) plus equality with the
  // driver the door requested; no driver-name list.
  const routeMatches =
    interactive === undefined
      ? (compiled.profile.brokerDriver === ASPD_BROKER_DRIVER ||
          compiled.profile.brokerDriver === ASPD_MUSE_BROKER_DRIVER) &&
        compiled.profile.interactionMode === 'headless'
      : isInteractiveTmuxBrokerProfile(compiled.profile) &&
        compiled.profile.brokerDriver === interactive.brokerDriver &&
        decideInteractiveTmuxExecutionRoute(compileIntent, compiled.profile, {
          brokerFlagEnabled: true,
          allowedBrokerDriver: interactive.brokerDriver,
        }) === 'broker'
  if (!routeMatches) {
    throw aspdStartError(
      'aspd_route_profile_mismatch',
      interactive === undefined
        ? 'aspd selected a profile outside the headless broker route'
        : `aspd selected a profile outside the interactive ${interactive.brokerDriver} route`,
      {
        hostSessionId: session.hostSessionId,
        runId,
        brokerDriver: compiled.profile.brokerDriver,
        interactionMode: compiled.profile.interactionMode,
        ...(interactive !== undefined ? { requestedBrokerDriver: interactive.brokerDriver } : {}),
      }
    )
  }
  const hostingUnproven = workerHostingUnproven(release, compiled.profile.brokerDriver)
  if (hostingUnproven !== undefined) {
    writeServerLog('WARN', 'aspd.preparation.hosting_unproven', {
      hostSessionId: session.hostSessionId,
      runId,
      brokerDriver: compiled.profile.brokerDriver,
      hostedDrivers: hostingUnproven.hostedDrivers,
      executionReleaseId: release.releaseId,
    })
    throw aspdStartError(
      'aspd_worker_hosting_unproven',
      `the aspd execution release does not prove it hosts ${compiled.profile.brokerDriver}; refusing without fallback`,
      {
        hostSessionId: session.hostSessionId,
        runId,
        brokerDriver: compiled.profile.brokerDriver,
        hostedDrivers: hostingUnproven.hostedDrivers,
        executionReleaseId: release.releaseId,
        aspdRelease: prepared.service.release,
      }
    )
  }
  const permissionMode = compiled.profile.policy.permissionPolicy.mode
  if (permissionMode === 'ask-client') {
    throw aspdStartError(
      'ask_client_unsupported',
      'ask-client permission mode is unsupported for HRC-owned broker dispatch',
      { hostSessionId: session.hostSessionId, runId, permissionMode }
    )
  }
  const actuatorSplitAuthority = await assertActuatorSplitAdmission({
    intent,
    route: interactive === undefined ? 'broker' : 'interactive-broker',
    startRequest: compiled.startRequest,
    preparedAuthority: input.preparedAuthority,
  })

  const mergedDispatchEnv = { ...(compiled.dispatchEnv ?? {}), ...hrcDispatchEnv }
  if (extractPiSdkBrokerCredentialEnv(mergedDispatchEnv, compiled.startRequest) !== undefined) {
    // Broker-process credentials are never persisted; this route carries none.
    throw aspdStartError(
      'aspd_route_profile_mismatch',
      'aspd-prepared route cannot carry broker credential env',
      { hostSessionId: session.hostSessionId, runId }
    )
  }
  const dispatchEnv = filterBrokerDispatchEnvForLockedEnv(mergedDispatchEnv, compiled.startRequest)
  const lifecyclePolicy = resolveLifecyclePolicyOverlay({
    routeId: `${interactive === undefined ? 'headless-broker' : 'interactive-broker'}:${compiled.profile.brokerDriver}`,
    brokerRoute: true,
  })
  const operationId = String(compiled.identity.operationId)
  const brokerDriver = compiled.profile.brokerDriver
  const route: AspdPreparationRoute =
    interactive === undefined
      ? brokerDriver === ASPD_MUSE_BROKER_DRIVER
        ? 'headless-muse-serve'
        : 'headless-codex-app-server'
      : aspdInteractiveRouteFor(brokerDriver)
  const presentation: AspdHostingPresentation | undefined =
    interactive === undefined
      ? aspdRoutePresentation(intent, process.env)
      : route === 'interactive-codex-tui'
        ? 'codex-tui'
        : 'interactive-tui'
  if (presentation === undefined) {
    throw aspdStartError(
      'aspd_route_profile_mismatch',
      'intent left the aspd route between selection and preparation',
      { hostSessionId: session.hostSessionId, runId }
    )
  }
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
          flag:
            brokerDriver === ASPD_MUSE_BROKER_DRIVER
              ? HRC_HEADLESS_MUSE_BROKER_ENABLED_ENV
              : HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
          selectedBy: 'aspdHeadlessBrokerEndpoint',
          headlessRoute: 'durable-leased',
          brokerTransport: 'unix-jsonrpc-ndjson',
          operatorPresentation: presentation,
          operatorPresentationSource: operatorPresentationSource(intent),
          ...aspdRouteDecision,
        }
      : {
          // T-08556 (§1.4), T-08560 (§1.5), T-08562 (§1.6): an interactive birth by any door.
          route: 'broker',
          flag: interactive.flagEnvName,
          selectedBy: 'decideInteractiveTmuxExecutionRoute',
          durableInteractiveRoute: 'durable-ipc',
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
      profile: compiled.profile,
      startRequest: compiled.startRequest,
      specHash: compiled.specHash,
      startRequestHash: compiled.startRequestHash,
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
    intent,
  }

  // Boundary P: one transaction, before any hosting effect.
  server.db.sqlite.transaction(() => {
    server.db.compiledRuntimePlans.insert({
      planHash: String(compiled.plan.planHash),
      compileId: String(compiled.plan.compileId),
      schemaVersion: compiled.plan.schemaVersion,
      compilerName: compiled.plan.compiler.name,
      compilerVersion: compiled.plan.compiler.version,
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
      selectedProfileId: String(compiled.profile.profileId),
      selectedProfileHash: String(compiled.profile.profileHash),
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
  // T-08562 (§1.6.6): route AND driver; two non-Codex drivers share a route.
  if (resumable.route === selected.route && resumable.driverKind === selected.driverKind) return
  throw aspdStartError(
    'aspd_preparation_route_changed',
    `the frozen aspd preparation is ${resumable.route}/${resumable.driverKind}; this retry selected ${selected.route}/${selected.driverKind}`,
    {
      reason: 'aspd_preparation_route_changed',
      operationId: resumable.operationId,
      runId: resumable.runId,
      hostSessionId,
      frozenRoute: resumable.route,
      selectedRoute: selected.route,
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
  // The route and its presentation are one frozen fact: the interactive TUI
  // route hosts only `codex-tui`, the headless route only its decided viewer.
  const interactiveDoor =
    record.dispatch.routeDecision['door'] === 'attached-run' ||
    record.dispatch.routeDecision['door'] === 'interactive-birth'
  const presentationMatchesRoute =
    record.route === 'interactive-codex-tui'
      ? record.hosting.presentation === 'codex-tui' &&
        record.hosting.driverKind === ASPD_BROKER_DRIVER &&
        interactiveDoor
      : record.route === 'interactive-tmux-broker'
        ? // T-08562 (§1.6.4): the frozen driver is bound back to the admitted profile.
          record.hosting.presentation === 'interactive-tui' &&
          record.hosting.driverKind !== ASPD_BROKER_DRIVER &&
          record.hosting.driverKind === record.admission.profile.brokerDriver &&
          interactiveDoor
        : record.route === 'headless-codex-app-server'
          ? record.hosting.driverKind === ASPD_BROKER_DRIVER &&
            record.hosting.presentation !== 'codex-tui' &&
            record.hosting.presentation !== 'interactive-tui' &&
            record.dispatch.routeDecision['operatorPresentation'] === record.hosting.presentation
          : record.route === 'headless-muse-serve'
            ? record.hosting.driverKind === ASPD_MUSE_BROKER_DRIVER &&
              (record.hosting.presentation === 'none' ||
                record.hosting.presentation === 'observer') &&
              record.dispatch.routeDecision['operatorPresentation'] === record.hosting.presentation
            : false
  if (
    JSON.stringify(expectedArgv) !== JSON.stringify(record.hosting.argv) ||
    JSON.stringify(currentPaths) !== JSON.stringify(record.hosting.paths) ||
    !presentationMatchesRoute
  ) {
    refuse('launch_description_mismatch', 'frozen worker launch description no longer matches', {
      frozenArgv: record.hosting.argv,
    })
  }

  // T-08562 (§1.6.3): re-check the hosting evidence from persisted bytes.
  const launchHostingUnproven = workerHostingUnproven(
    record.executionRelease,
    record.admission.profile.brokerDriver
  )
  if (launchHostingUnproven !== undefined) {
    refuse(
      'aspd_worker_hosting_unproven',
      `the frozen execution release does not prove it hosts ${record.admission.profile.brokerDriver}`,
      {
        brokerDriver: record.admission.profile.brokerDriver,
        hostedDrivers: launchHostingUnproven.hostedDrivers,
      }
    )
  }

  writeServerLog('INFO', 'aspd.launch.begin', { ...detail, executable })
  options.birthTimeline?.mark('aspd-launch-authority-validated', detail)
  const controller = server.getHarnessBrokerController()
  const admission = record.admission
  const result = await controller.start({
    plan: admission.plan,
    profile: admission.profile,
    startRequest: admission.startRequest,
    specHash: admission.specHash,
    startRequestHash: admission.startRequestHash,
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
      route: record.route,
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
    options.settleFailure(result.error)
  }
  writeServerLog('INFO', 'aspd.launch.started', {
    ...detail,
    invocationId: result.invocation.invocationId,
    workerRelease: result.hello.release?.releaseId,
  })
  return { runtime: result.runtime, intent: record.intent }
}
