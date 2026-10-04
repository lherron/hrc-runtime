import { randomUUID } from 'node:crypto'
import { HrcBadRequestError, HrcErrorCode, isCodexAppOwnedScopeRef } from 'hrc-core'
import type {
  DispatchTurnBySelectorResponse,
  DispatchTurnResponse,
  HrcDeliveryOutcome,
  HrcDeliveryWarning,
  HrcDmRuntimeIntent,
  HrcMessageAddress,
  HrcMessageRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
  SemanticDmResponse,
  WaitMessageResponse,
} from 'hrc-core'
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import {
  hasLeasedBrokerSubstrate,
  parseBrokerRuntimeHostingState,
} from './broker/runtime-hosting.js'
import { projectSemanticTurnResponse } from './event-notification-handlers.js'
import {
  assertProvisionDirectiveAdmissible,
  assertScopeNotRetired,
} from './federation/summon-gate-server.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import {
  type CompleteSemanticDmRequest,
  formatDmPayload,
  formatSessionRef,
  parseSemanticDmRequest,
} from './messages.js'
import { resolveParticipantDelivery } from './participant-delivery.js'
import { findLatestRuntime } from './runtime-select.js'
import { omitPersistedSelectionForReuse } from './selector-message-handlers/selection-request.js'
import {
  HRC_BUSY_HEADLESS_DM_REJECTION_CODE,
  HRC_BUSY_HEADLESS_DM_REJECTION_MESSAGE,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { isLiveProcess } from './server-lock.js'
import { writeServerLog } from './server-log.js'
import { parseJsonBody } from './server-parsers.js'
import {
  assertDispatchRunId,
  isRuntimeUnavailableStatus,
  json,
  requireDispatchRuntimeId,
  timestamp,
} from './server-util.js'
import {
  type DurableBrokerDispatchReattachResult,
  reattachDurableBrokerForDispatch,
} from './startup-reconcile.js'
import { assertReplyScopeMatches } from './target-message-handoff-handlers.js'
import {
  federationOriginNodeId,
  originDispatchOption,
  requireCompleteRuntimeIntent,
  scopeRefOf,
} from './target-message-shared.js'
import { createNotifiedSessionSuccessor } from './target-message-successor-handlers.js'
import { findTargetSession } from './target-view.js'
import { createTmuxManager } from './tmux.js'
import { submissionResponse, submitThroughAdmission } from './turn-admission/submit.js'
import type { AdmittedPlan } from './turn-admission/types.js'

/**
 * `POST /v1/messages/dm` — local semantic DM.
 *
 * T-07612 flag day (T-07616): agent-to-agent TALK left this route. `hrcchat dm`
 * forwards to `wrkc say`, ACP writes the wrkq ledger, and the federated half of
 * this path is deleted, so nothing in the collective addresses it any more.
 *
 * The route itself is NOT fenced this wave, deliberately. It carries the
 * daedalus-ratified steer-class contract (T-07203 r7 / T-07214) that the wrkq
 * the retired kicker urgent actuation was built on, and fencing a route no caller
 * reaches would buy nothing observable while stranding that contract's
 * coverage. It retires in wave 5 (T-07617) together with the delivery machinery
 * below it and the `messages` table itself.
 */
export async function handleSemanticDm(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const parsedBody = parseSemanticDmRequest(await parseJsonBody(request))
  if (parsedBody.freshContext !== undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'freshContext is only supported by /v1/messages/turn-handoff',
      { field: 'freshContext', route: 'semantic-dm' }
    )
  }
  // T-07398 cycle 1 (D3): an INADMISSIBLE directive is refused here, before the
  // message row, the routing decision and any session mint — and regardless of
  // whether the target is live. Shape and the deny-list were already re-checked
  // in the parser; this is the half that needs the TARGET (its pin, its home,
  // and this node's peer registry), so it cannot live in the parser.
  if (parsedBody.to.kind === 'session' && parsedBody.runtimeIntent?.provision !== undefined) {
    await assertProvisionDirectiveAdmissible(this, {
      scopeRef: scopeRefOf(parsedBody.to.sessionRef),
      provision: parsedBody.runtimeIntent.provision,
    })
  }

  // T-07398 cycle 2: a dm to an ALREADY-EXISTING scope carries its directive
  // block as a provision-only intent — deliberately without placement, so
  // existing-scope delivery keeps working against a drifted checkout (T-07151).
  // Complete it HERE, once, before any consumer that needs a whole intent:
  // downstream this value becomes the dispatch intent, the auto-summon intent
  // and the archived-successor intent, none of which can run on a fragment.
  const body: CompleteSemanticDmRequest =
    parsedBody.to.kind === 'session'
      ? {
          ...parsedBody,
          runtimeIntent: completeDirectiveOnlyIntent(
            this,
            parsedBody.to.sessionRef,
            parsedBody.runtimeIntent
          ),
        }
      : { ...parsedBody, runtimeIntent: requireCompleteRuntimeIntent(parsedBody.runtimeIntent) }

  const parent =
    body.replyToMessageId !== undefined
      ? this.db.messages.getById(body.replyToMessageId)
      : undefined

  if (body.replyToMessageId !== undefined && !parent) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `unknown replyToMessageId "${body.replyToMessageId}"`,
      {
        field: 'replyToMessageId',
        replyToMessageId: body.replyToMessageId,
      }
    )
  }

  if (parent) assertReplyScopeMatches(parent, body.to, body.allowCrossScopeReply)

  if (body.responseFormat !== undefined && body.to.kind !== 'session') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'responseFormat requires a session turn target',
      {
        field: 'responseFormat',
        route: 'semantic-dm',
        reason: 'responseFormat requires a session turn target',
      }
    )
  }

  if (body.to.kind === 'session') {
    const targetSessionRef = body.to.sessionRef
    const scopeRef = scopeRefOf(targetSessionRef)
    const assertLocalTargetNotRetired = () =>
      assertScopeNotRetired(this, {
        scopeRef,
        path: 'archived-successor',
        advisoryCoveredByDownstreamGate: () => {
          const session = findTargetSession(this.db, targetSessionRef)
          if (session?.status === 'archived' && session.continuation?.key) return true
          return (
            session === undefined &&
            body.createIfMissing !== false &&
            body.runtimeIntent !== undefined &&
            !isCodexAppOwnedScopeRef(targetSessionRef)
          )
        },
      })

    // A loser-node retirement fence forbids local execution; it does not
    // retire the active binding held by another node. Resolve the authoritative
    // route first so a reconciled loser can originate a DM to the winner. If
    // routing is unavailable/unbound, preserve the more specific local
    // retirement refusal before surfacing the routing error.
    // T-07612 §10 (flag day T-07616): the federation MESSAGE path is deleted,
    // so there is no remote branch left — every target this daemon admits is
    // local, and cross-node work travels the wrkq ledger.
    if (findTargetSession(this.db, targetSessionRef) === undefined) {
      assertLocalPersonaAllowed(this, scopeRef)
      await assertLocalTargetNotRetired()
    }
  }

  // T-07398 — provisioning is decided at BIRTH. A directive block arriving at a
  // scope that is already live cannot take effect (no hot-swap), so the honest
  // answer is to deliver anyway and say so: the sender learns the block did not
  // apply instead of reading a delivered reply as proof that it did. Observed
  // BEFORE delivery, because delivery is exactly what can create the runtime
  // that would otherwise make a birth look like a live scope.
  const directivesApplied =
    body.runtimeIntent?.provision === undefined ? undefined : !targetHasLiveRuntime(this, body.to)

  const respondTo = body.respondTo ?? body.from
  let written: HrcMessageRecord | undefined
  const persistAndDeliver = async (plan?: AdmittedPlan): Promise<Response> => {
    const record = this.insertAndNotifyMessage({
      messageId: `msg-${randomUUID()}`,
      kind: 'dm',
      phase: parent !== undefined ? 'response' : body.to.kind === 'session' ? 'request' : 'oneway',
      from: body.from,
      to: body.to,
      body: body.body,
      ...(body.replyToMessageId !== undefined ? { replyToMessageId: body.replyToMessageId } : {}),
      ...(parent ? { rootMessageId: parent.rootMessageId } : {}),
      execution: {
        state: 'not_applicable',
        ...(body.mode && body.mode !== 'auto' ? { mode: body.mode } : {}),
      },
    })

    written = record
    const { execution, reply, warnings, delivery } = await this.deliverPersistedSemanticDm(
      body,
      record,
      respondTo,
      plan
    )

    // Handle --wait
    let waited: WaitMessageResponse | undefined
    if (body.wait?.enabled && record.phase === 'request') {
      const timeoutMs = body.wait.timeoutMs ?? 30_000
      waited = await this.waitForMessage(
        {
          thread: { rootMessageId: record.rootMessageId },
          to: respondTo,
          kinds: ['dm'],
          phases: ['response'],
          afterSeq: record.messageSeq,
        },
        timeoutMs,
        record.messageId
      )
    }

    // Re-read the record to pick up execution updates written by the durable
    // correlation join and tmux-literal delivery path (updateExecution calls
    // modify the DB but not the in-memory record object).
    const freshRecord = this.db.messages.getById(record.messageId) ?? record

    return json({
      request: freshRecord,
      ...(execution ? { execution } : {}),
      ...(reply ? { reply } : {}),
      ...(waited ? { waited } : {}),
      ...(warnings ? { warnings } : {}),
      ...(delivery ? { delivery } : {}),
      ...(directivesApplied === undefined ? {} : { directivesApplied }),
    } satisfies SemanticDmResponse)
  }
  if (body.to.kind !== 'session' || isCodexAppOwnedScopeRef(body.to.sessionRef))
    return await persistAndDeliver()
  let target = findTargetSession(this.db, body.to.sessionRef)
  if (target == null && body.createIfMissing !== false && body.runtimeIntent !== undefined)
    target = await this.ensureTargetSession(body.to.sessionRef, body.runtimeIntent)
  if (target == null) return await persistAndDeliver()
  // Ledger-only, unsummoned DMs retain their non-turn behavior.
  if (
    body.runtimeIntent === undefined &&
    target.lastAppliedIntentJson === undefined &&
    resolveParticipantDelivery(this, target) === null
  )
    return await persistAndDeliver()
  const result = await submitThroughAdmission(
    this,
    {
      door: 'dm',
      intent: 'enqueue',
      target,
      body: body.body,
      principal: body.from.kind === 'entity' ? body.from.entity : body.from.sessionRef,
      runtimeIntent: body.runtimeIntent,
      executionFormat: 'format1',
      responseFormat: body.responseFormat,
      allowStaleGeneration: body.allowStaleGeneration,
      signal: request.signal,
      options: {
        runId: `run-${randomUUID()}`,
        waitForCompletion: body.wait?.enabled === true,
        joinInFlightRuntimeStart: true,
      },
      replay: async () => {
        throw new Error('DM has no idempotency key')
      },
    },
    async (plan) => ({ kind: 'accepted', value: await persistAndDeliver(plan) })
  )
  // The existing DM route returns its failed message rather than throwing an HTTP error.
  // Classification occurs before that projection, so a route throw stays possible_write.
  if (result.outcome === 'possible_write' && written !== undefined)
    return json({
      request: this.db.messages.getById(written.messageId) ?? written,
      ...(directivesApplied === undefined ? {} : { directivesApplied }),
    })
  return submissionResponse(result)
}

export function completeDirectiveOnlyIntent(
  server: HrcServerInstanceForHandlers,
  sessionRef: string,
  intent: HrcDmRuntimeIntent | undefined
): HrcRuntimeIntent | undefined {
  if (intent === undefined) return undefined
  if (intent.placement !== undefined) return intent
  // Truthiness, not `=== undefined`: a persisted-but-null intent would spread
  // to `{}` and silently rebuild the very fragment this function exists to
  // remove.
  const persisted = findTargetSession(server.db, sessionRef)?.lastAppliedIntentJson
  const base = omitPersistedSelectionForReuse(persisted)
  if (!base) return undefined
  return { ...base, ...(intent.provision === undefined ? {} : { provision: intent.provision }) }
}

/**
 * Whether the DM's target already has a live runtime — i.e. whether this
 * dispatch is a delivery into an existing runtime rather than a birth.
 *
 * Non-session targets (entity/selector addressing) are treated as births: they
 * resolve to a scope through the ordinary summon path, where a directive is
 * applied at mint time like any other birth.
 */
function targetHasLiveRuntime(
  server: HrcServerInstanceForHandlers,
  to: HrcMessageAddress
): boolean {
  if (to.kind !== 'session') return false
  const session = findTargetSession(server.db, to.sessionRef)
  if (session === null) return false
  return server.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .some((runtime) => !isRuntimeUnavailableStatus(runtime.status))
}

/** Filterable durable delivery projection consumed by the F3 operator CLI. */
export async function deliverPersistedSemanticDm(
  this: HrcServerInstanceForHandlers,
  body: CompleteSemanticDmRequest,
  record: HrcMessageRecord,
  respondTo: HrcMessageAddress,
  plan?: AdmittedPlan
): Promise<{
  execution?: DispatchTurnBySelectorResponse | undefined
  reply?: HrcMessageRecord | undefined
  warnings?: HrcDeliveryWarning[] | undefined
  delivery?: HrcDeliveryOutcome | undefined
}> {
  let execution: DispatchTurnBySelectorResponse | undefined
  let reply: HrcMessageRecord | undefined
  let warnings: HrcDeliveryWarning[] | undefined
  let delivery: HrcDeliveryOutcome | undefined
  const summonOrigin = federationOriginNodeId(record) === undefined ? 'local' : 'federated-ingress'

  // T-05161: a DM to a Codex.app-owned address (task segment `codex-<uuid7>`)
  // must be persisted (Cody-in-codex.app live-polls the DM list) but must NOT
  // summon a session, spawn a local codex-cli runtime, or live-deliver. Skip
  // the entire session/dispatch block; the message is returned as-is below.
  const codexAppOwnedTarget =
    body.to.kind === 'session' && isCodexAppOwnedScopeRef(body.to.sessionRef)
  if (codexAppOwnedTarget && body.to.kind === 'session') {
    writeServerLog('INFO', 'semantic_dm.codex_app_owned_no_dispatch', {
      messageId: record.messageId,
      sessionRef: body.to.sessionRef,
    })
  }

  if (body.to.kind === 'session' && !codexAppOwnedTarget) {
    assertLocalPersonaAllowed(this, scopeRefOf(body.to.sessionRef))
    // Auto-summon if needed
    let session = plan?.session ?? findTargetSession(this.db, body.to.sessionRef)
    if (!session && body.createIfMissing !== false) {
      const intent = body.runtimeIntent
      if (intent) {
        session = await this.ensureTargetSession(body.to.sessionRef, intent, summonOrigin)
      }
    }

    if (session) {
      if (plan === undefined && session.status === 'archived' && session.continuation?.key) {
        session = await createNotifiedSessionSuccessor(
          this,
          session,
          body.runtimeIntent,
          summonOrigin
        )
      }

      // Rotate before delivery if the target session is stale and the
      // caller did not opt in to stale reuse. This both prevents DMs from
      // silently dispatching into corrupted legacy sessions and keeps the
      // tmux-literal path using a fresh continuation for future turns.
      if (plan === undefined)
        session = (
          await this.maybeAutoRotateStaleSession(session, {
            allowStaleGeneration: body.allowStaleGeneration,
            trigger: 'semantic-dm',
          })
        ).session

      // Durable correlation join (F2e): persist session-level correlation at
      // insert time so that `hrc monitor wait msg:<id>` can resolve the
      // target session even if no turn is dispatched (e.g. unsummoned target,
      // no runtimeIntent). This survives the originating dm-process exit.
      this.db.messages.updateExecution(record.messageId, {
        sessionRef: formatSessionRef(session.scopeRef, session.laneRef),
        hostSessionId: session.hostSessionId,
        generation: session.generation,
      })

      // Semantic DMs are obligation-bearing queue-class submissions. The broker
      // holds them while a turn is active; HRC never guesses busy from run rows.
      const liveInteractiveRuntime = findLatestRuntime(this.db, session.hostSessionId)
      if (
        liveInteractiveRuntime &&
        liveInteractiveRuntime.transport === 'tmux' &&
        !isRuntimeUnavailableStatus(liveInteractiveRuntime.status) &&
        liveInteractiveRuntime.controllerKind !== 'harness-broker'
      ) {
        this.markRuntimeStaleForBrokerReprovision(session, liveInteractiveRuntime, {
          reason: 'semantic-dm-nonbroker-reuse-rejected',
          route: 'semantic-dm',
        })
      }

      const result = await this.executeSemanticTurn(session, body, record, respondTo, {
        waitForCompletion: body.wait?.enabled === true,
        admissionPlan: plan,
      })
      execution = result.execution
      reply = result.reply
      warnings = result.warnings
      delivery = result.delivery
    }
  }

  return { execution, reply, warnings, delivery }
}

export function rejectBusyHeadlessSemanticDm(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  record: HrcMessageRecord,
  runtime: HrcRuntimeSnapshot
): void {
  const sessionRef = formatSessionRef(session.scopeRef, session.laneRef)
  const activeRunId = runtime.activeRunId

  this.db.messages.updateExecution(record.messageId, {
    state: 'failed',
    mode: 'headless',
    sessionRef,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    ...(activeRunId ? { runId: activeRunId } : {}),
    transport: 'headless',
    errorCode: HRC_BUSY_HEADLESS_DM_REJECTION_CODE,
    errorMessage: HRC_BUSY_HEADLESS_DM_REJECTION_MESSAGE,
  })

  const event = appendHrcEvent(this.db, 'input.rejected', {
    ts: timestamp(),
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    ...(activeRunId ? { runId: activeRunId } : {}),
    transport: 'headless',
    errorCode: HRC_BUSY_HEADLESS_DM_REJECTION_CODE,
    payload: {
      reason: 'busy-headless-runtime',
      delivery: 'semantic-dm',
      messageId: record.messageId,
      sessionRef,
      runtimeId: runtime.runtimeId,
      ...(activeRunId ? { activeRunId } : {}),
      bodyLength: record.body.length,
      recommendation: 'retry after current turn completes or use hrcchat turn',
    },
  })
  this.notifyEvent(event)

  writeServerLog('INFO', 'semantic_dm.busy_headless_rejected', {
    messageId: record.messageId,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    activeRunId,
  })
}

export async function executeSemanticTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  body: {
    runtimeIntent?: HrcRuntimeIntent | undefined
    body: string
    from: HrcMessageAddress
    to: HrcMessageAddress
    responseFormat?: HrcTurnResponseFormat | undefined
  },
  record: HrcMessageRecord,
  respondTo: HrcMessageAddress,
  options: {
    waitForCompletion?: boolean | undefined
    admissionPlan?: AdmittedPlan | undefined
  } = {}
): Promise<{
  execution?: DispatchTurnBySelectorResponse
  reply?: HrcMessageRecord | undefined
  warnings?: HrcDeliveryWarning[] | undefined
  delivery?: HrcDeliveryOutcome | undefined
}> {
  const baseIntent =
    body.runtimeIntent ??
    (session.lastAppliedIntentJson === undefined
      ? undefined
      : omitPersistedSelectionForReuse(session.lastAppliedIntentJson))
  if (!baseIntent && options.admissionPlan?.participant == null) return {}

  try {
    const latestRuntime = this.db.runtimes.listByHostSessionId(session.hostSessionId).at(-1)
    if (
      latestRuntime?.controllerKind === 'harness-broker' &&
      (latestRuntime.status === 'crashed' || latestRuntime.status === 'stale') &&
      hasLeasedBrokerSubstrate(latestRuntime)
    ) {
      await this.reattachLiveSemanticDmSubstrate(latestRuntime)
    }

    const runId = options.admissionPlan?.options.runId ?? `run-${randomUUID()}`
    const payload = formatDmPayload(
      body.from,
      body.to,
      body.body,
      record.messageSeq,
      record.createdAt
    )
    const turnResponse = await this.dispatchTurnForSession(
      session,
      options.admissionPlan?.runtimeIntent ?? baseIntent,
      payload,
      {
        ...options.admissionPlan?.options,
        admissionPlan: options.admissionPlan,
        runId,
        waitForCompletion: options.waitForCompletion,
        submissionDoor: 'enqueue',
        responseFormat: body.responseFormat,
        // T-07236: see above — provenance from the durable DM sender.
        ...originDispatchOption(body.from, this.db),
        // T-07202: a semantic DM can cross another DM while an interactive
        // broker is still cold-provisioning. Join that host-session boot and
        // deliver this DM through its winning runtime instead of minting a
        // second runtime. Other dispatch sources retain their current policy.
        joinInFlightRuntimeStart: true,
      }
    )
    const turnBody = (await turnResponse.json()) as DispatchTurnResponse
    assertDispatchRunId(turnBody)
    const transport = turnBody.transport as 'sdk' | 'tmux' | 'headless'

    // T-07203: a steer outcome means this message's text joined (or was
    // presented into) ANOTHER run. Delivery of THIS message is terminal, and
    // reply synthesis must be skipped — the active turn's runtimeBuffers are
    // that turn's output, not a reply to the steer sender.
    const steerDelivery =
      turnBody.delivery?.code === 'admitted_into_active_turn' ||
      turnBody.delivery?.code === 'presented_to_live_harness'
        ? turnBody.delivery
        : undefined
    if (steerDelivery !== undefined) {
      const steeredRunId =
        steerDelivery.code === 'admitted_into_active_turn'
          ? steerDelivery.mergedIntoRunId
          : steerDelivery.presentedDuringRunId
      this.db.messages.updateExecution(record.messageId, {
        state: 'completed',
        mode: transport === 'sdk' ? 'nonInteractive' : 'headless',
        sessionRef: formatSessionRef(session.scopeRef, session.laneRef),
        hostSessionId: turnBody.hostSessionId,
        generation: turnBody.generation,
        runtimeId: requireDispatchRuntimeId(turnBody),
        runId: steeredRunId,
        transport,
      })
      return { warnings: turnBody.warnings, delivery: steerDelivery }
    }

    // T-07969: one body authority. This used to join the raw runtime buffer,
    // which since the Claude authority cutover is the whole narrated stream and
    // not the answer. The projection selects the turn's final message.
    let finalOutput: string | undefined
    if (transport !== 'tmux') {
      const { body } = projectSemanticTurnResponse(this.db, turnBody.runId)
      if (body.length > 0) {
        finalOutput = body
      }
    }

    const turnStatus = turnBody.status as 'completed' | 'started'
    const execution: DispatchTurnBySelectorResponse = {
      runId: turnBody.runId,
      sessionRef: formatSessionRef(session.scopeRef, session.laneRef),
      hostSessionId: turnBody.hostSessionId,
      generation: turnBody.generation,
      runtimeId: requireDispatchRuntimeId(turnBody),
      transport,
      mode: transport === 'sdk' ? 'nonInteractive' : 'headless',
      status: turnStatus,
      finalOutput,
      continuationUpdated: turnStatus === 'completed',
    }

    this.db.messages.updateExecution(record.messageId, {
      state: turnStatus === 'completed' ? 'completed' : 'started',
      mode: execution.mode,
      sessionRef: execution.sessionRef,
      hostSessionId: execution.hostSessionId,
      generation: execution.generation,
      runtimeId: execution.runtimeId,
      runId: execution.runId,
      transport: execution.transport,
    })

    let reply: HrcMessageRecord | undefined
    if (finalOutput && finalOutput.trim().length > 0) {
      reply = this.insertAndNotifyMessage({
        messageId: `msg-${randomUUID()}`,
        kind: 'dm',
        phase: 'response',
        from: body.to,
        to: respondTo,
        body: finalOutput,
        replyToMessageId: record.messageId,
        rootMessageId: record.rootMessageId,
        execution: {
          state: 'completed',
          mode: execution.mode,
          sessionRef: execution.sessionRef,
          hostSessionId: execution.hostSessionId,
          generation: execution.generation,
          runtimeId: execution.runtimeId,
          runId: execution.runId,
          transport: execution.transport,
        },
      })
    }

    return { execution, reply, warnings: turnBody.warnings, delivery: turnBody.delivery }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const latestRuntime = findLatestRuntime(this.db, session.hostSessionId)
    writeServerLog('WARN', 'semantic_dm.execution_failed', {
      messageId: record.messageId,
      originNodeId: federationOriginNodeId(record),
      scopeRef: session.scopeRef,
      hostSessionId: session.hostSessionId,
      runtimeId: latestRuntime?.runtimeId,
      runId: latestRuntime?.activeRunId,
      runtimeStatus: latestRuntime?.status,
      transport: latestRuntime?.transport,
      errorName: err instanceof Error ? err.name : undefined,
      error: errorMessage,
    })
    this.db.messages.updateExecution(record.messageId, {
      state: 'failed',
      errorCode: 'semantic_dm_execution_failed',
      errorMessage,
    })
    if (options.admissionPlan !== undefined) throw err
    return {}
  }
}

type SemanticDmLiveSubstrateGuardDeps = {
  createTmuxManager(options: { socketPath: string }): {
    listSessionNames(): Promise<string[]>
    inspectPaneProcess(
      paneId: string
    ): Promise<{ command: string; pid: number; dead: boolean } | null>
  }
  isLiveProcess(pid: number): boolean
  reattach(runtime: HrcRuntimeSnapshot): Promise<DurableBrokerDispatchReattachResult>
  log(level: 'INFO', message: string, fields: Record<string, unknown>): void
}

/**
 * T-07047: a crashed/stale row is not sufficient authority to mint over a
 * broker whose recorded leased-tmux substrate is still alive. This is the one
 * exceptional probe on the semantic-DM mint edge: prove the recorded session
 * and broker-pane PID, then prefer the existing durable reattach. Any probe or
 * clean reattach miss leaves the row untouched and falls through to today's
 * ordinary fresh-provision path.
 */
export async function reattachLiveSemanticDmSubstrate(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  deps: Partial<SemanticDmLiveSubstrateGuardDeps> = {}
): Promise<boolean> {
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (
    runtime.controllerKind !== 'harness-broker' ||
    (runtime.status !== 'crashed' && runtime.status !== 'stale') ||
    hosting?.substrate.kind !== 'leased-tmux'
  ) {
    return false
  }

  try {
    const substrate = hosting.substrate
    const leaseTmux = (deps.createTmuxManager ?? createTmuxManager)({
      socketPath: substrate.tmuxSocketPath,
    })
    const sessionExists = (await leaseTmux.listSessionNames()).includes(substrate.sessionName)
    const paneProcess = sessionExists
      ? await leaseTmux.inspectPaneProcess(substrate.brokerWindow.paneId)
      : null
    if (
      paneProcess === null ||
      paneProcess.pid <= 0 ||
      paneProcess.dead ||
      !(deps.isLiveProcess ?? isLiveProcess)(paneProcess.pid)
    ) {
      return false
    }

    const outcome = deps.reattach
      ? await deps.reattach(runtime)
      : await reattachDurableBrokerForDispatch(this.db, runtime, {
          runtimeRoot: this.options.runtimeRoot,
          controller: this.getHarnessBrokerController(),
          inFlightOperations: this.brokerReattachOperations,
          brokerUnixClientFactory:
            this.brokerUnixClientFactory ??
            ((options) =>
              connectObservedBrokerUnixClient(options) as ReturnType<BrokerUnixClientFactory>),
        })
    if (outcome.state !== 'reattached') {
      return false
    }
    ;(deps.log ?? writeServerLog)('INFO', 'dm.mint_averted_live_substrate', {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
    })
    return true
  } catch {
    // A failed direct probe/reattach is not proof that the recorded substrate
    // can serve input. Preserve the existing semantic-DM mint fallthrough.
    return false
  }
}
