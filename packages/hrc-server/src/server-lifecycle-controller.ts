import { randomUUID } from 'node:crypto'

import {
  HRC_LIFECYCLE_CREDENTIAL_HEADER,
  HRC_LIFECYCLE_PRE_CONTRACT_MESSAGE,
  HRC_LIFECYCLE_RUNTIME_HEADER,
  HRC_LIFECYCLE_SESSION_REF_HEADER,
  HrcBadRequestError,
  HrcDomainError,
  HrcErrorCode,
} from 'hrc-core'
import type {
  HrcServerLifecycleAction,
  HrcServerLifecycleFlags,
  HrcServerLifecycleGrant,
  HrcServerLifecycleRemoteProof,
  HrcServerLifecycleResponse,
  HrcTurnAdmissionCloseRequest,
} from 'hrc-core'

import type { PeerEntry } from './federation/federation-config.js'
import { isValidNodeId } from './federation/node-id.js'
import { buildPeerProtocolHeaders } from './federation/peer-request.js'
import { type InFlightWork, listInFlightWork, waitForInFlightDrain } from './in-flight-work.js'
import {
  type LifecycleAuthorityNode,
  type LifecycleRefusal,
  type LifecycleRefusalCode,
  authorizeLocalLifecycleCaller,
  checkLifecycleAttestation,
  lifecycleRefusalText,
} from './server-lifecycle-authority.js'
import type {
  LifecycleCredentialBinding,
  LifecycleCredentialStore,
} from './server-lifecycle-credentials.js'
import { writeServerLog } from './server-log.js'

/**
 * T-09861 §5 — the daemon authorizes, then gates/waits/drains, then records
 * the grant and performs the stop or restart ITSELF. `--wait`, `--drain` and
 * `--force` change how an authorized action runs, never whether it is allowed:
 * every one of them is behind the authority check, so a refusal changes no
 * state (no wait, no admission close, no signal).
 */

/** Performs an authorized action; wired only by the production daemon (`hrc server serve`). */
export type ServerLifecycleExecutor = (grant: HrcServerLifecycleGrant) => void

const DEFAULT_WAIT_TIMEOUT_MS = 300_000
const DEFAULT_REMOTE_PROOF_TIMEOUT_MS = 60_000
/** The ack must reach the caller before teardown closes the listener. */
const EXECUTE_AFTER_ACK_MS = 150

export type ServerLifecycleControllerOptions = {
  readonly node: () => LifecycleAuthorityNode
  readonly peers: () => ReadonlyMap<string, PeerEntry>
  readonly dbPath: string
  readonly credentials: LifecycleCredentialStore
  readonly isLive: (binding: LifecycleCredentialBinding) => boolean
  readonly turnAdmission: {
    close(request: HrcTurnAdmissionCloseRequest): Promise<unknown>
    reopen(operationId?: string): Promise<unknown>
  }
  readonly executor: () => ServerLifecycleExecutor | undefined
}

type ParsedLifecycleBody = {
  action: HrcServerLifecycleAction
  reason: string | undefined
  targetNode: string | undefined
  flags: HrcServerLifecycleFlags
  waitTimeoutMs: number
  drainTimeoutMs: number
  proofTimeoutMs: number
  requestedRunId: string | undefined
}

const LOCAL_BODY_FIELDS = new Set([
  'action',
  'reason',
  'targetNode',
  'wait',
  'drain',
  'force',
  'waitTimeoutMs',
  'drainTimeoutMs',
  'proofTimeoutMs',
  'requestedRunId',
])

const PEER_BODY_FIELDS = new Set([
  'requestId',
  'originNode',
  'requestedBy',
  'callerKind',
  'reason',
  'action',
  'flags',
  'waitTimeoutMs',
  'drainTimeoutMs',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(message: string, field?: string): never {
  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    message,
    field === undefined ? {} : { field }
  )
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field]
  if (value === undefined) return false
  if (typeof value !== 'boolean') malformed(`${field} must be a boolean`, field)
  return value
}

function optionalPositiveInt(
  body: Record<string, unknown>,
  field: string,
  fallback: number
): number {
  const value = body[field]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    malformed(`${field} must be a positive integer`, field)
  }
  return value
}

function optionalText(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') malformed(`${field} must be a string`, field)
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function parseAction(value: unknown): HrcServerLifecycleAction {
  if (value !== 'stop' && value !== 'restart') malformed('action must be stop or restart', 'action')
  return value
}

function parseFlags(value: {
  wait: boolean
  drain: boolean
  force: boolean
  action: HrcServerLifecycleAction
}): HrcServerLifecycleFlags {
  if (value.drain && value.wait) {
    malformed('--drain and --wait are mutually exclusive; --drain owns the closed-admission wait')
  }
  if (value.drain && value.action !== 'restart') malformed('--drain applies to restart only')
  return { wait: value.wait, drain: value.drain, force: value.force }
}

function parseLocalBody(raw: unknown): ParsedLifecycleBody {
  if (!isRecord(raw)) malformed('lifecycle request body must be a JSON object')
  for (const key of Object.keys(raw)) {
    if (!LOCAL_BODY_FIELDS.has(key)) malformed(`unknown field ${key}`, key)
  }
  const action = parseAction(raw['action'])
  const targetNode = optionalText(raw, 'targetNode')
  if (targetNode !== undefined && !isValidNodeId(targetNode)) {
    malformed('targetNode is not a valid nodeId', 'targetNode')
  }
  return {
    action,
    reason: optionalText(raw, 'reason'),
    targetNode,
    flags: parseFlags({
      wait: optionalBoolean(raw, 'wait'),
      drain: optionalBoolean(raw, 'drain'),
      force: optionalBoolean(raw, 'force'),
      action,
    }),
    waitTimeoutMs: optionalPositiveInt(raw, 'waitTimeoutMs', DEFAULT_WAIT_TIMEOUT_MS),
    drainTimeoutMs: optionalPositiveInt(raw, 'drainTimeoutMs', DEFAULT_WAIT_TIMEOUT_MS),
    proofTimeoutMs: optionalPositiveInt(raw, 'proofTimeoutMs', DEFAULT_REMOTE_PROOF_TIMEOUT_MS),
    requestedRunId: optionalText(raw, 'requestedRunId'),
  }
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)
  return value === null || value.trim().length === 0 ? undefined : value.trim()
}

function refusalError(refusal: LifecycleRefusal): HrcDomainError {
  return new HrcDomainError(HrcErrorCode.SERVER_LIFECYCLE_REFUSED, refusal.message, {
    refusal: refusal.code,
    ...(refusal.code === 'lifecycle_in_progress' ? { retryable: true } : {}),
  })
}

function inFlightError(input: {
  refusalCode: string
  message: string
  inFlight: readonly InFlightWork[]
}): HrcDomainError {
  return new HrcDomainError(HrcErrorCode.SERVER_LIFECYCLE_IN_FLIGHT, input.message, {
    refusalCode: input.refusalCode,
    inFlight: input.inFlight,
  })
}

export type PeerLifecycleOutcome = {
  readonly status: number
  readonly body: Record<string, unknown>
}

export class ServerLifecycleController {
  /** One lifecycle action at a time; set from authorization until the process exits (or the gate refuses). */
  #inProgress = false

  constructor(private readonly options: ServerLifecycleControllerOptions) {}

  /** Whether this daemon can perform an action (the status capability). */
  get capable(): boolean {
    return this.options.executor() !== undefined
  }

  /** `POST /v1/server/lifecycle` on the local socket. */
  async handleLocalRequest(request: Request): Promise<Response> {
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      malformed('lifecycle request body must be JSON')
    }
    const body = parseLocalBody(raw)
    const node = this.options.node()
    const targetNodeId = body.targetNode ?? node.nodeId
    const caller = {
      runtimeId: header(request, HRC_LIFECYCLE_RUNTIME_HEADER),
      credential: header(request, HRC_LIFECYCLE_CREDENTIAL_HEADER),
      attributedSessionRef: header(request, HRC_LIFECYCLE_SESSION_REF_HEADER),
    }

    const authorization = authorizeLocalLifecycleCaller({
      action: body.action,
      targetNodeId,
      caller,
      node,
      verifyCredential: (runtimeId, value) => this.options.credentials.verify(runtimeId, value),
      isLive: this.options.isLive,
    })
    const refuse = (refusal: LifecycleRefusal): never => {
      this.logRefusal(refusal, {
        action: body.action,
        targetNode: targetNodeId,
        flags: body.flags,
        attributedCaller: caller.attributedSessionRef ?? null,
        runtimeId: caller.runtimeId ?? null,
      })
      throw refusalError(refusal)
    }
    if (!authorization.allowed) return refuse(authorization)

    const remote = targetNodeId !== node.nodeId
    const refusalFor = (code: LifecycleRefusalCode, detail: string): LifecycleRefusal => ({
      allowed: false,
      code,
      message: `${lifecycleRefusalText({
        action: body.action,
        targetNodeId,
        project: authorization.projectId,
      })} (${detail})`,
    })
    if (remote && authorization.callerKind !== 'mable-primary') {
      return refuse(
        refusalFor(
          'node_local_cross_node',
          `${authorization.requestedBy} is a node-local seat and may act only on its own node ${node.nodeId}`
        )
      )
    }
    if (body.reason === undefined) {
      return refuse(refusalFor('reason_required', '--reason <text> is required'))
    }

    const grantBase = {
      requestId: `lifecycle-${randomUUID()}`,
      requestedBy: authorization.requestedBy,
      callerKind: authorization.callerKind,
      originNode: node.nodeId,
      reason: body.reason,
      action: body.action,
      flags: body.flags,
    } satisfies HrcServerLifecycleGrant

    if (remote) {
      const peer = this.options.peers().get(targetNodeId)
      if (peer === undefined) {
        return refuse(
          refusalFor('unknown_node', `${targetNodeId} is not a configured federation peer`)
        )
      }
      return this.forwardToPeer(peer, grantBase, body, refuse)
    }

    const outcome = await this.executeLocally({
      grant: grantBase,
      waitTimeoutMs: body.waitTimeoutMs,
      drainTimeoutMs: body.drainTimeoutMs,
      requestedRunId: body.requestedRunId,
      logContext: { attributedCaller: caller.attributedSessionRef ?? null },
    })
    if ('refusal' in outcome) return refuse(outcome.refusal)
    if ('inFlightError' in outcome) throw outcome.inFlightError
    return Response.json(outcome.response)
  }

  /** `POST /v1/federation/server-lifecycle` from an authenticated peer. */
  async handlePeerRequest(input: {
    readonly authenticatedNodeId: string
    readonly body: Readonly<Record<string, unknown>>
  }): Promise<PeerLifecycleOutcome> {
    const body = input.body
    const node = this.options.node()
    const invalid = (message: string): PeerLifecycleOutcome => ({
      status: 400,
      body: { ok: false, error: { code: 'invalid_request', message } },
    })
    for (const key of Object.keys(body)) {
      if (!PEER_BODY_FIELDS.has(key)) return invalid(`unknown field ${key}`)
    }
    const text = (field: string): string | undefined => {
      const value = body[field]
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
    }
    const action = body['action']
    if (action !== 'stop' && action !== 'restart') return invalid('action must be stop or restart')
    const flagsRaw = body['flags']
    if (
      !isRecord(flagsRaw) ||
      Object.keys(flagsRaw).some((key) => key !== 'wait' && key !== 'drain' && key !== 'force') ||
      Object.values(flagsRaw).some((value) => typeof value !== 'boolean')
    ) {
      return invalid('flags must be {wait, drain, force} booleans')
    }
    const requestId = text('requestId')
    const originNode = text('originNode')
    const requestedBy = text('requestedBy')
    const callerKind = text('callerKind')
    if (
      requestId === undefined ||
      originNode === undefined ||
      requestedBy === undefined ||
      callerKind === undefined
    ) {
      return invalid('requestId, originNode, requestedBy and callerKind are required')
    }
    let flags: HrcServerLifecycleFlags
    try {
      flags = parseFlags({
        wait: flagsRaw['wait'] === true,
        drain: flagsRaw['drain'] === true,
        force: flagsRaw['force'] === true,
        action,
      })
    } catch (error) {
      return invalid(error instanceof Error ? error.message : String(error))
    }
    const timeout = (field: string): number => {
      const value = body[field]
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : DEFAULT_WAIT_TIMEOUT_MS
    }

    const refusePeer = (refusal: LifecycleRefusal): PeerLifecycleOutcome => {
      this.logRefusal(refusal, {
        action,
        targetNode: node.nodeId,
        flags,
        attributedCaller: requestedBy,
        originNode,
        authenticatedNodeId: input.authenticatedNodeId,
        callerKind,
      })
      return {
        status: refusal.code === 'lifecycle_in_progress' ? 409 : 403,
        body: {
          ok: false,
          error: {
            code: HrcErrorCode.SERVER_LIFECYCLE_REFUSED,
            message: refusal.message,
            detail: { refusal: refusal.code },
          },
        },
      }
    }

    const attestation = checkLifecycleAttestation({
      authenticatedNodeId: input.authenticatedNodeId,
      originNode,
      callerKind,
      requestedBy,
      action,
      localNodeId: node.nodeId,
    })
    if (attestation !== undefined) return refusePeer(attestation)
    const reason = text('reason')
    if (reason === undefined) {
      return refusePeer({
        allowed: false,
        code: 'reason_required',
        message: `${lifecycleRefusalText({ action, targetNodeId: node.nodeId, project: '<project>' })} (--reason <text> is required)`,
      })
    }

    const outcome = await this.executeLocally({
      grant: {
        requestId,
        requestedBy,
        callerKind: 'mable-primary',
        originNode,
        reason,
        action,
        flags,
      },
      waitTimeoutMs: timeout('waitTimeoutMs'),
      drainTimeoutMs: timeout('drainTimeoutMs'),
      requestedRunId: undefined,
      logContext: { authenticatedNodeId: input.authenticatedNodeId },
    })
    if ('refusal' in outcome) return refusePeer(outcome.refusal)
    if ('inFlightError' in outcome) {
      const error = outcome.inFlightError
      return {
        status: 409,
        body: {
          ok: false,
          error: { code: error.code, message: error.message, detail: error.detail },
        },
      }
    }
    return { status: 200, body: { ...outcome.response } }
  }

  private async executeLocally(input: {
    grant: HrcServerLifecycleGrant
    waitTimeoutMs: number
    drainTimeoutMs: number
    requestedRunId: string | undefined
    logContext: Record<string, unknown>
  }): Promise<
    | { response: HrcServerLifecycleResponse }
    | { refusal: LifecycleRefusal }
    | { inFlightError: HrcDomainError }
  > {
    const { grant } = input
    const node = this.options.node()
    const executor = this.options.executor()
    if (executor === undefined) {
      return {
        refusal: {
          allowed: false,
          code: 'executor_unavailable',
          message: `this HRC server instance cannot perform lifecycle actions on ${node.nodeId}`,
        },
      }
    }
    if (this.#inProgress) {
      return {
        refusal: {
          allowed: false,
          code: 'lifecycle_in_progress',
          message: `a lifecycle action is already in progress on ${node.nodeId}`,
        },
      }
    }
    this.#inProgress = true

    let notes: string[] = []
    let admissionOperationId: string | undefined
    try {
      if (grant.flags.drain) {
        const drained = await this.closeAdmissionAndDrain(grant, input.drainTimeoutMs, {
          requestedRunId: input.requestedRunId,
        })
        admissionOperationId = drained.operationId
        notes = drained.notes
      } else if (!grant.flags.force) {
        await this.gateOnInFlightWork(grant.action, grant.flags.wait, input.waitTimeoutMs, {
          requestedRunId: input.requestedRunId,
        })
      }
    } catch (error) {
      this.#inProgress = false
      if (admissionOperationId !== undefined) {
        await this.options.turnAdmission.reopen(admissionOperationId).catch(() => undefined)
      }
      if (
        error instanceof HrcDomainError &&
        error.code === HrcErrorCode.SERVER_LIFECYCLE_IN_FLIGHT
      ) {
        writeServerLog('WARN', 'server.lifecycle.gate_refused', {
          requestId: grant.requestId,
          action: grant.action,
          requestedBy: grant.requestedBy,
          detail: error.detail['refusalCode'],
        })
        return { inFlightError: error }
      }
      throw error
    }

    writeServerLog('INFO', 'server.lifecycle.granted', {
      ...grant,
      ...input.logContext,
      ...(notes.length === 0 ? {} : { notes }),
    })
    setTimeout(() => {
      try {
        executor(grant)
      } catch (error) {
        this.#inProgress = false
        writeServerLog('ERROR', 'server.lifecycle.execute_failed', {
          requestId: grant.requestId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }, EXECUTE_AFTER_ACK_MS)

    return {
      response: {
        ok: true,
        accepted: true,
        targetNode: node.nodeId,
        grant,
        ...(notes.length === 0 ? {} : { notes }),
      },
    }
  }

  /**
   * Stop gates every run; restart skips tmux runs (tmux-owned, they survive a
   * daemon restart). No --wait: refuse listing the work. --wait: poll, then
   * refuse on timeout. Nothing is actuated on a refusal.
   */
  private async gateOnInFlightWork(
    action: HrcServerLifecycleAction,
    wait: boolean,
    waitTimeoutMs: number,
    options: { requestedRunId: string | undefined }
  ): Promise<void> {
    const filter = {
      ...(action === 'restart' ? { excludeTransports: ['tmux'] as const } : {}),
      ...(options.requestedRunId === undefined ? {} : { excludeRunId: options.requestedRunId }),
    }
    const noun = action === 'restart' ? 'headless run' : 'run'
    let inFlight = listInFlightWork(this.options.dbPath, filter)
    if (inFlight.length === 0) return
    if (!wait) {
      const refusalCode =
        action === 'restart' ? 'restart_refused_in_flight' : 'stop_refused_in_flight'
      throw inFlightError({
        refusalCode,
        message: `refusing to ${action}: ${inFlight.length} ${noun}(s) in flight. Use --wait to drain or --force to ${action} anyway.`,
        inFlight,
      })
    }
    inFlight = await waitForInFlightDrain({
      dbPath: this.options.dbPath,
      timeoutMs: waitTimeoutMs,
      filter,
    })
    if (inFlight.length > 0) {
      const refusalCode = action === 'restart' ? 'restart_drain_timeout' : 'stop_drain_timeout'
      throw inFlightError({
        refusalCode,
        message: `drain timed out after ${waitTimeoutMs}ms with ${inFlight.length} ${noun}(s) still in flight. Re-run with --force to ${action} anyway.`,
        inFlight,
      })
    }
  }

  /**
   * `--drain`: close turn admission (durable; the successor reopens it at
   * boot), wait for headless work, recheck under the closed gate, and fall back
   * explicitly to force semantics on timeout.
   */
  private async closeAdmissionAndDrain(
    grant: HrcServerLifecycleGrant,
    timeoutMs: number,
    options: { requestedRunId: string | undefined }
  ): Promise<{ operationId: string; notes: string[] }> {
    const operationId = `restart-drain-${randomUUID()}`
    await this.options.turnAdmission.close({
      operationId,
      requestedBy: grant.requestedBy,
      requestedRunId: options.requestedRunId ?? null,
      reason: grant.reason,
    })
    const filter = {
      excludeTransports: ['tmux'] as const,
      includeAcceptedRuns: true,
      ...(options.requestedRunId === undefined ? {} : { excludeRunId: options.requestedRunId }),
    }
    await waitForInFlightDrain({ dbPath: this.options.dbPath, timeoutMs, filter })
    const remaining = listInFlightWork(this.options.dbPath, filter)
    const notes = [`turn admission closed (${operationId})`]
    if (remaining.length > 0) {
      notes.push(
        `drain timed out after ${timeoutMs}ms with ${remaining.length} headless run(s) still in flight; falling back explicitly to force restart semantics under closed admission`
      )
    } else {
      notes.push('drain complete; closed-admission recheck found no headless work')
    }
    return { operationId, notes }
  }

  private async forwardToPeer(
    peer: PeerEntry,
    grant: HrcServerLifecycleGrant,
    body: ParsedLifecycleBody,
    refuse: (refusal: LifecycleRefusal) => never
  ): Promise<Response> {
    const before = grant.action === 'restart' ? await peerStartedAt(peer) : null
    const attestation = {
      requestId: grant.requestId,
      originNode: grant.originNode,
      requestedBy: grant.requestedBy,
      callerKind: grant.callerKind,
      reason: grant.reason,
      action: grant.action,
      flags: grant.flags,
      waitTimeoutMs: body.waitTimeoutMs,
      drainTimeoutMs: body.drainTimeoutMs,
    }
    const budgetMs =
      Math.max(
        grant.flags.wait ? body.waitTimeoutMs : 0,
        grant.flags.drain ? body.drainTimeoutMs : 0
      ) + 30_000
    let response: Response
    try {
      response = await fetch(new URL('/v1/federation/server-lifecycle', peer.endpoint), {
        method: 'POST',
        headers: buildPeerProtocolHeaders(peer, { contentType: 'application/json' }),
        body: JSON.stringify(attestation),
        signal: AbortSignal.timeout(budgetMs),
      })
    } catch (error) {
      throw new HrcDomainError(
        HrcErrorCode.RUNTIME_UNAVAILABLE,
        `could not reach ${peer.nodeId} over federation: ${error instanceof Error ? error.message : String(error)}`,
        { targetNode: peer.nodeId, retryable: true }
      )
    }
    let payload: Record<string, unknown> = {}
    try {
      const parsed = (await response.json()) as unknown
      if (isRecord(parsed)) payload = parsed
    } catch {}

    if (!response.ok) {
      const error = isRecord(payload['error']) ? payload['error'] : {}
      const code = typeof error['code'] === 'string' ? error['code'] : undefined
      const message =
        typeof error['message'] === 'string' ? error['message'] : `HTTP ${response.status}`
      const detail = isRecord(error['detail']) ? error['detail'] : {}
      if (code === HrcErrorCode.SERVER_LIFECYCLE_IN_FLIGHT) {
        throw new HrcDomainError(HrcErrorCode.SERVER_LIFECYCLE_IN_FLIGHT, message, {
          ...detail,
          targetNode: peer.nodeId,
        })
      }
      if (response.status === 404) {
        return refuse({
          allowed: false,
          code: 'attestation_refused',
          message: `${peer.nodeId}: ${HRC_LIFECYCLE_PRE_CONTRACT_MESSAGE}`,
        })
      }
      return refuse({
        allowed: false,
        code: 'attestation_refused',
        message: `${peer.nodeId} refused: ${message}`,
      })
    }

    let remoteProof: HrcServerLifecycleRemoteProof | undefined
    if (grant.action === 'restart') {
      remoteProof = await provePeerRestart(peer, before, body.proofTimeoutMs)
    }
    writeServerLog('INFO', 'server.lifecycle.forwarded', {
      ...grant,
      targetNode: peer.nodeId,
      ...(remoteProof === undefined ? {} : { remote: remoteProof }),
    })
    return Response.json({
      ok: true,
      accepted: true,
      targetNode: peer.nodeId,
      grant,
      ...(remoteProof === undefined ? {} : { remote: remoteProof }),
    } satisfies HrcServerLifecycleResponse)
  }

  private logRefusal(refusal: LifecycleRefusal, context: Record<string, unknown>): void {
    if (refusal.code === 'credential_mismatch') {
      writeServerLog('WARN', 'server.lifecycle.credential_mismatch', {
        ...context,
        message: refusal.message,
      })
    }
    writeServerLog('WARN', 'server.lifecycle.refused', {
      refusal: refusal.code,
      message: refusal.message,
      ...context,
    })
  }
}

async function peerStartedAt(peer: PeerEntry): Promise<string | null> {
  try {
    const response = await fetch(new URL('/v1/federation/health', peer.endpoint), {
      headers: buildPeerProtocolHeaders(peer),
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return null
    const body = (await response.json()) as unknown
    return isRecord(body) && typeof body['startedAt'] === 'string' ? body['startedAt'] : null
  } catch {
    return null
  }
}

/** A cross-node restart is proven when the target's federation health reports a new startedAt. */
async function provePeerRestart(
  peer: PeerEntry,
  before: string | null,
  timeoutMs: number
): Promise<HrcServerLifecycleRemoteProof> {
  const deadline = Date.now() + timeoutMs
  let after: string | null = null
  while (Date.now() < deadline) {
    after = await peerStartedAt(peer)
    if (after !== null && after !== before) {
      return { beforeStartedAt: before, afterStartedAt: after, proven: true }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return { beforeStartedAt: before, afterStartedAt: after, proven: false }
}
