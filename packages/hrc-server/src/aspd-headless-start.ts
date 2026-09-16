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
 */
import { randomUUID } from 'node:crypto'

import { HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
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
import {
  decideCodexAppServerPresentation,
  extractPiSdkBrokerCredentialEnv,
  filterBrokerDispatchEnvForLockedEnv,
  toRuntimeContinuationRef,
} from './broker-decisions.js'
import { describeBrokerSubstratePaths } from './broker-interactive-handlers/substrate-allocator.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import { buildManagedBrokerDispatchEnv } from './managed-broker-runtime-env.js'
import type { PrecompileLaunchTimingContext } from './precompile-launch-timing.js'
import {
  HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION_ENV,
  HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { type DispatchRunPersistenceOptions, dispatchRunPersistence } from './server-types.js'
import { timestamp } from './server-util.js'
import { automaticContinuationForSession } from './session-continuation-reuse.js'
import { toBrokerResponseFormat } from './turn-response-format.js'

export const ASPD_PREPARATION_SCHEMA = 'hrc-aspd-preparation/v1'
const ASPD_BROKER_DRIVER = 'codex-app-server'

type OkCompileResponse = Extract<AspcCompileHarnessInvocationResponse, { ok: true }>

/** The frozen preparation persisted in `runtime_operations.preparation_json`. */
export type AspdPreparationRecord = {
  schemaVersion: typeof ASPD_PREPARATION_SCHEMA
  route: 'headless-codex-app-server'
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
    driverKind: typeof ASPD_BROKER_DRIVER
    presentation: 'none'
    executable: string
    argv: string[]
    paths: ReturnType<typeof describeBrokerSubstratePaths>
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
 * The route this module owns: the node declares an aspd endpoint and the intent
 * is ordinary headless codex-app-server with operator presentation `none`.
 * Returns the endpoint, or undefined for every other route.
 */
export function aspdHeadlessCodexEndpoint(
  intent: HrcRuntimeIntent,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (intent.harness.interactive === true) return undefined
  if (toProfileSelector(intent)?.brokerDriver !== ASPD_BROKER_DRIVER) return undefined
  const presentation = decideCodexAppServerPresentation({
    operatorPresentation: env[HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION_ENV],
    brokerDriver: ASPD_BROKER_DRIVER,
  })
  if (presentation !== 'none') return undefined
  return configuredAspdEndpoint(env)
}

function aspdStartError(
  code: string,
  message: string,
  detail: Record<string, unknown>
): HrcRuntimeUnavailableError {
  return new HrcRuntimeUnavailableError(message, { code, route: 'aspd', ...detail })
}

export type AspdPrepareInput = {
  session: HrcSessionRecord
  intent: HrcRuntimeIntent
  preparedAuthority?: Parameters<typeof assertActuatorSplitAdmission>[0]['preparedAuthority']
  runId: string
  endpoint: string
  allowCompilerInitialInputWithoutIdentity?: boolean | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
  dispatchIdempotencyKey?: string | undefined
  timing?: PrecompileLaunchTimingContext | undefined
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
  const compiled = await compileBrokerRuntimePlan(
    {
      intent,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      dispatchEnv: hrcDispatchEnv,
      continuation: toRuntimeContinuationRef(automaticContinuationForSession(server.db, session)),
      allowCompilerInitialInputWithoutIdentity: input.allowCompilerInitialInputWithoutIdentity,
      responseFormat: input.responseFormat,
    },
    {
      compileHarnessInvocation: async (request) => {
        prepared = await prepareThroughAspd(endpoint, request)
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
  if (
    compiled.profile.brokerDriver !== ASPD_BROKER_DRIVER ||
    compiled.profile.interactionMode !== 'headless'
  ) {
    throw aspdStartError(
      'aspd_route_profile_mismatch',
      'aspd selected a profile outside the headless codex-app-server route',
      {
        hostSessionId: session.hostSessionId,
        runId,
        brokerDriver: compiled.profile.brokerDriver,
        interactionMode: compiled.profile.interactionMode,
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
    route: 'broker',
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
    routeId: `headless-broker:${compiled.profile.brokerDriver}`,
    brokerRoute: true,
  })
  const operationId = String(compiled.identity.operationId)
  const paths = describeBrokerSubstratePaths(server.options, ASPD_BROKER_DRIVER, runtimeId)
  const argv = buildAspdWorkerArgv(release, {
    socketPath: paths.brokerIpcSocketPath,
    eventLedgerPath: paths.eventLedgerPath,
    runtimeId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    attachTokenPath: paths.attachTokenPath,
  })
  const runtimeAuthority = actuatorSplitRuntimeAuthority(actuatorSplitAuthority)
  const requestedResponseFormat = toBrokerResponseFormat(input.responseFormat)
  const preparedAt = timestamp()
  const record: AspdPreparationRecord = {
    schemaVersion: ASPD_PREPARATION_SCHEMA,
    route: 'headless-codex-app-server',
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
      driverKind: ASPD_BROKER_DRIVER,
      presentation: 'none',
      executable: release.worker.executable,
      argv,
      paths,
    },
    dispatch: {
      ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
      ...(lifecyclePolicy !== undefined ? { lifecyclePolicy } : {}),
      routeDecision: {
        route: 'broker',
        flag: HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
        selectedBy: 'aspdHeadlessCodexEndpoint',
        headlessRoute: 'durable-leased',
        brokerTransport: 'unix-jsonrpc-ndjson',
        operatorPresentation: 'none',
        preparation: 'aspd',
        aspdEndpoint: endpoint,
        aspdRelease: prepared.service.release,
        executionReleaseId: release.releaseId,
      },
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
 * The never-submitted preparation a same-key caller retry resumes, if any.
 * Status `prepared` is the only resumable state.
 */
export function findPreparedAspdAttemptForRetry(
  server: Pick<HrcServerInstanceForHandlers, 'db'>,
  hostSessionId: string,
  dispatchIdempotencyKey: string
): { operationId: string; runId: string } | undefined {
  for (const operation of server.db.runtimeOperations.listPreparedByHostSession(hostSessionId)) {
    if (operation.preparationJson === undefined) continue
    try {
      const record = JSON.parse(operation.preparationJson) as AspdPreparationRecord
      if (
        record.schemaVersion === ASPD_PREPARATION_SCHEMA &&
        record.dispatchIdempotencyKey === dispatchIdempotencyKey
      ) {
        return { operationId: operation.operationId, runId: record.runId }
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
  const expectedArgv = buildAspdWorkerArgv(record.executionRelease, {
    socketPath: record.hosting.paths.brokerIpcSocketPath,
    eventLedgerPath: record.hosting.paths.eventLedgerPath,
    runtimeId: record.runtimeId,
    hostSessionId: record.hostSessionId,
    generation: record.generation,
    attachTokenPath: record.hosting.paths.attachTokenPath,
  })
  const currentPaths = describeBrokerSubstratePaths(
    server.options,
    record.hosting.driverKind,
    record.runtimeId
  )
  if (
    JSON.stringify(expectedArgv) !== JSON.stringify(record.hosting.argv) ||
    JSON.stringify(currentPaths) !== JSON.stringify(record.hosting.paths)
  ) {
    refuse('launch_description_mismatch', 'frozen worker launch description no longer matches', {
      frozenArgv: record.hosting.argv,
    })
  }

  writeServerLog('INFO', 'aspd.launch.begin', { ...detail, executable })
  const controller = server.getHarnessBrokerController()
  const admission = record.admission
  const result = await controller.start({
    plan: admission.plan,
    profile: admission.profile,
    startRequest: admission.startRequest,
    specHash: admission.specHash,
    startRequestHash: admission.startRequestHash,
    identity: admission.identity,
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
    options.settleFailure(result.error)
  }
  writeServerLog('INFO', 'aspd.launch.started', {
    ...detail,
    invocationId: result.invocation.invocationId,
    workerRelease: result.hello.release?.releaseId,
  })
  return { runtime: result.runtime, intent: record.intent }
}
