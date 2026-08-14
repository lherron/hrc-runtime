/**
 * HRC → ACP reason-coded event bridge, emitter side (T-07236).
 *
 * Durable law `hrc-runtime.acp-event-bridge`: an enabled bridge observes only
 * COMMITTED, allowlisted reason-coded facts and emits the frozen schema-v1 ACP
 * envelope with node-qualified event identity, the recorded initiating origin
 * and causation, and a pointer-only payload. Emission is durably rate-bounded,
 * runs after commit without affecting the originating write, and is best-effort
 * rather than a second source of truth.
 *
 * The durable fact is always HRC's own ledger row. This module is a nudge: a
 * missed delivery degrades automation, never correctness. It therefore has no
 * outbox, no retry queue beyond a small bounded budget, and no path by which a
 * failure — of the network, of ACP, of this code — can reach the write that
 * produced the event.
 *
 * The envelope's `payload` is IDENTIFIERS AND POINTERS ONLY. No pane text, no
 * argv, no prompt material: the consumer fetches detail through
 * `hrc runtime diagnostics <trip-event-id>`, so the secret boundary stays inside
 * HRC and the bridge cannot become an exfiltration seam.
 */
import { parseScopeRef } from 'agent-scope'
import type { HrcDispatchOrigin, HrcLifecycleEvent, HrcRunRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { writeServerLog } from './server-log.js'

export const HRC_ACP_WEBHOOK_URL_ENV = 'HRC_ACP_WEBHOOK_URL'
export const HRC_ACP_NODE_ID_ENV = 'HRC_ACP_NODE_ID'
export const HRC_ACP_EVENT_ALLOWLIST_ENV = 'HRC_ACP_EVENT_ALLOWLIST'
export const HRC_ACP_EVENT_RATE_CAP_ENV = 'HRC_ACP_EVENT_RATE_CAP'

/** Frozen: the envelope version ACP's parser accepts and nothing else. */
export const ACP_WEBHOOK_SCHEMA_VERSION = 1
/** Frozen: HRC's producer identity on the shared ACP listener. */
export const ACP_WEBHOOK_SOURCE = 'hrc'

export const DEFAULT_ACP_EVENT_ALLOWLIST = 'first_turn_missing'
export const DEFAULT_ACP_EVENT_RATE_CAP = 3
export const ACP_EVENT_RATE_WINDOW_MS = 60 * 60 * 1000
/** Emission slots are only ever read back over one window; keep a day for forensics. */
export const ACP_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000

export const ACP_BRIDGE_DELIVERY_ATTEMPTS = 3
export const ACP_BRIDGE_DELIVERY_BUDGET_MS = 5_000
const ACP_BRIDGE_BASE_BACKOFF_MS = 200

/** The honest residue for a dispatch with no attributable initiator. */
export const ACP_BRIDGE_SYSTEM_ORIGIN: { actor: string; kind: 'system' } = {
  actor: 'system:hrc',
  kind: 'system',
}

export type AcpWebhookOriginBlock = {
  actor: string
  kind: 'human' | 'agent' | 'system'
  causation_ref?: string
}

/**
 * The frozen schema-v1 envelope. Snake_case on the wire (ACP's contract),
 * camelCase inside `payload` (HRC's field names, also frozen — the ACP example
 * job's templates read `{{payload.nodeId}}` and friends verbatim).
 */
export type AcpWebhookEnvelope = {
  schema_version: 1
  source: 'hrc'
  event_id: string
  event_seq: number
  event: string
  occurred_at: string
  origin: AcpWebhookOriginBlock
  subject: { type: 'hrc-runtime'; id: string }
  payload: {
    nodeId: string
    runtimeId: string
    scopeRef: string
    generation: number
    invocationId?: string
    runId?: string
    tripEventId: string
    retrievalHint: string
  }
}

export type AcpBridgeDisabledReason =
  | 'url_unset'
  | 'url_empty'
  | 'url_invalid'
  | 'url_not_loopback'
  | 'coresident_node_unset'
  | 'node_identity_not_declared'
  | 'node_not_coresident'

export type AcpBridgeActivation =
  | {
      enabled: true
      url: string
      nodeId: string
      allowlist: ReadonlySet<string>
      rateCapPerWindow: number
    }
  | { enabled: false; reason: AcpBridgeDisabledReason; detail?: string | undefined }

export type AcpBridgeNodeIdentity = {
  nodeId: string
  nodeIdProvenance: 'declared' | 'derived'
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]
  return raw === undefined ? undefined : raw.trim()
}

function parseAllowlist(raw: string | undefined): ReadonlySet<string> {
  const source = raw === undefined || raw === '' ? DEFAULT_ACP_EVENT_ALLOWLIST : raw
  return new Set(
    source
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  )
}

function parseRateCap(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_ACP_EVENT_RATE_CAP
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ACP_EVENT_RATE_CAP
}

/**
 * Activation, stated once and consistently.
 *
 * Two independent keys must agree, and neither has a default:
 *
 *  1. `HRC_ACP_WEBHOOK_URL` — unset OR empty means DISABLED, full stop. There is
 *     no inferred default URL anywhere; ambient environment never carries
 *     intent. The URL must address the loopback listener, because v1 adds no
 *     authentication or signing and ACP's route is loopback-trusted.
 *  2. `HRC_ACP_NODE_ID` — the deployment's DECLARED ACP-co-resident node, which
 *     must equal this daemon's own CONFIGURED node identity. v1 is confined to
 *     the co-resident node: ACP executes job runs on its own execution node
 *     regardless of payload content, so a trip emitted from a second node would
 *     hand a retrieval hint to a daemon that cannot read that ledger. Comparing
 *     two pieces of configuration is what keeps this honest — no node name is
 *     written into this code, which would rot the moment a deployment moves.
 *
 * The local identity must additionally be `declared`: an identity derived from
 * the machine's hostname is not configuration authority, and a hostname that
 * happens to match the declared co-resident name is a coincidence, not a
 * statement of co-residency.
 */
export function resolveAcpBridgeActivation(input: {
  env: NodeJS.ProcessEnv
  node: AcpBridgeNodeIdentity
}): AcpBridgeActivation {
  const rawUrl = readEnv(input.env, HRC_ACP_WEBHOOK_URL_ENV)
  if (rawUrl === undefined) return { enabled: false, reason: 'url_unset' }
  if (rawUrl === '') return { enabled: false, reason: 'url_empty' }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { enabled: false, reason: 'url_invalid', detail: rawUrl }
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && !LOOPBACK_HOSTS.has(`[${url.hostname}]`)) {
    return { enabled: false, reason: 'url_not_loopback', detail: url.hostname }
  }

  const coresidentNodeId = readEnv(input.env, HRC_ACP_NODE_ID_ENV)
  if (coresidentNodeId === undefined || coresidentNodeId === '') {
    return { enabled: false, reason: 'coresident_node_unset' }
  }
  if (input.node.nodeIdProvenance !== 'declared') {
    return { enabled: false, reason: 'node_identity_not_declared', detail: input.node.nodeId }
  }
  if (coresidentNodeId !== input.node.nodeId) {
    return {
      enabled: false,
      reason: 'node_not_coresident',
      detail: `${input.node.nodeId} != ${coresidentNodeId}`,
    }
  }

  return {
    enabled: true,
    url: rawUrl,
    nodeId: input.node.nodeId,
    allowlist: parseAllowlist(readEnv(input.env, HRC_ACP_EVENT_ALLOWLIST_ENV)),
    rateCapPerWindow: parseRateCap(readEnv(input.env, HRC_ACP_EVENT_RATE_CAP_ENV)),
  }
}

/**
 * The recorded initiating principal for a bridged event.
 *
 * Origin is PROPAGATED, never invented: it is read back from the dispatch that
 * armed the trip, so an agent-caused trip arrives at ACP labelled `agent` and
 * stays subject to the consumer's agent-origin policy. `system:hrc` is the
 * residue of genuinely unlabeled seams — not a convenient default for causes we
 * could have recorded and didn't.
 */
export function resolveBridgedOrigin(
  run: Pick<HrcRunRecord, 'originActor' | 'originKind' | 'originCausationRef'> | null | undefined
): AcpWebhookOriginBlock {
  const actor = run?.originActor
  const kind = run?.originKind
  if (
    typeof actor !== 'string' ||
    actor.length === 0 ||
    (kind !== 'human' && kind !== 'agent' && kind !== 'system')
  ) {
    return { ...ACP_BRIDGE_SYSTEM_ORIGIN }
  }
  return {
    actor,
    kind,
    ...(typeof run?.originCausationRef === 'string' && run.originCausationRef.length > 0
      ? { causation_ref: run.originCausationRef }
      : {}),
  }
}

/**
 * Origin for an hrcchat-dispatched turn, derived from the DURABLE sender on the
 * message record. hrcchat needs no wire change: the identity is already
 * recorded on the dispatch, so the honest answer is derivable here rather than
 * asked for — and an agent DM that wedges a runtime reaches ACP labelled
 * `agent`, which is the whole point of the transport.
 *
 * Returns undefined only for a sender whose scope cannot be parsed; the caller
 * then leaves the run unattributed rather than inventing an actor.
 */
export function dispatchOriginFromMessageAddress(
  from: { kind: 'session'; sessionRef: string } | { kind: 'entity'; entity: 'human' | 'system' }
): HrcDispatchOrigin | undefined {
  if (from.kind === 'entity') {
    return from.entity === 'human'
      ? { actor: 'human', kind: 'human' }
      : { ...ACP_BRIDGE_SYSTEM_ORIGIN }
  }
  let agentId: string
  try {
    agentId = parseScopeRef(from.sessionRef).agentId
  } catch {
    return undefined
  }
  if (typeof agentId !== 'string' || agentId.length === 0) return undefined
  return { actor: `agent:${agentId}`, kind: 'agent' }
}

/** The canonical retrieval path, executed against the ORIGINATING node's scope. */
export function acpBridgeRetrievalHint(tripEventSeq: number): string {
  return `hrc runtime diagnostics ${tripEventSeq}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the envelope from a committed ledger row.
 *
 * `event_id` is node-qualified — `<nodeId>:<tripEventSeq>` — because the local
 * ledger sequence is a per-database autoincrement, and several HRC nodes share
 * one ACP listener under a single `source: "hrc"`. ACP's inbox de-duplicates on
 * `source:event_id`, so an un-qualified id would let one node's real trip be
 * silently swallowed as a duplicate of another's.
 *
 * Returns null when the row cannot be addressed as a runtime fact (no runtimeId)
 * — there is nothing for a consumer to act on or retrieve, so nothing is sent.
 */
export function buildAcpBridgeEnvelope(input: {
  event: Pick<
    HrcLifecycleEvent,
    'hrcSeq' | 'ts' | 'eventKind' | 'runtimeId' | 'runId' | 'scopeRef' | 'generation' | 'payload'
  >
  nodeId: string
  origin: AcpWebhookOriginBlock
}): AcpWebhookEnvelope | null {
  const { event } = input
  const payload = isRecord(event.payload) ? event.payload : {}
  const runtimeId =
    event.runtimeId ?? (typeof payload['runtimeId'] === 'string' ? payload['runtimeId'] : undefined)
  if (runtimeId === undefined || runtimeId.length === 0) return null

  const invocationId =
    typeof payload['invocationId'] === 'string' ? payload['invocationId'] : undefined
  const runId = event.runId ?? (typeof payload['runId'] === 'string' ? payload['runId'] : undefined)

  return {
    schema_version: ACP_WEBHOOK_SCHEMA_VERSION,
    source: ACP_WEBHOOK_SOURCE,
    event_id: `${input.nodeId}:${event.hrcSeq}`,
    event_seq: event.hrcSeq,
    event: event.eventKind,
    // The HRC-RECORDED timestamp, never send time: a consumer reasoning about
    // when the fact happened must not be reading when the network cooperated.
    occurred_at: event.ts,
    origin: input.origin,
    subject: { type: 'hrc-runtime', id: runtimeId },
    payload: {
      nodeId: input.nodeId,
      runtimeId,
      scopeRef: event.scopeRef,
      generation: event.generation,
      ...(invocationId !== undefined ? { invocationId } : {}),
      ...(runId !== undefined ? { runId } : {}),
      tripEventId: String(event.hrcSeq),
      retrievalHint: acpBridgeRetrievalHint(event.hrcSeq),
    },
  }
}

/** Narrow injection seam: only the one call shape this module makes. */
export type AcpBridgeFetch = (
  input: string,
  init: RequestInit
) => Promise<{ ok: boolean; status: number }>

export type AcpEventBridgeDeps = {
  db: HrcDatabase
  node: AcpBridgeNodeIdentity
  env?: NodeJS.ProcessEnv | undefined
  fetchImpl?: AcpBridgeFetch | undefined
  now?: (() => string) | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
  /** Test seam for the retry jitter; production uses Math.random. */
  jitter?: (() => number) | undefined
}

export type AcpBridgeDeliveryOutcome =
  | { delivered: true; attempts: number }
  | { delivered: false; attempts: number; error: string }

/**
 * Post-commit observer hung off the `notifyEvent` seam.
 *
 * `observe()` is synchronous, never throws, and returns immediately: the
 * emission itself is detached onto a later task so that even a caller that
 * notifies from inside a transaction has committed by the time any of this
 * runs, and so no originating write can ever wait on the network.
 */
export class AcpEventBridge {
  private readonly activation: AcpBridgeActivation
  private readonly fetchImpl: AcpBridgeFetch
  private readonly now: () => string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly jitter: () => number
  /** Kept for tests and shutdown so a pending emission can be awaited. */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(private readonly deps: AcpEventBridgeDeps) {
    this.activation = resolveAcpBridgeActivation({
      env: deps.env ?? process.env,
      node: deps.node,
    })
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init))
    this.now = deps.now ?? (() => new Date().toISOString())
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.jitter = deps.jitter ?? (() => Math.random())
    if (this.activation.enabled) {
      writeServerLog('INFO', 'acp_event_bridge.enabled', {
        nodeId: this.activation.nodeId,
        url: this.activation.url,
        allowlist: [...this.activation.allowlist],
        rateCapPerHour: this.activation.rateCapPerWindow,
      })
    }
  }

  get enabled(): boolean {
    return this.activation.enabled
  }

  /** Non-secret projection for diagnostics/status surfaces. */
  describe(): AcpBridgeActivation {
    return this.activation
  }

  observe(event: HrcLifecycleEvent | { eventKind: string }): void {
    try {
      if (!this.activation.enabled) return
      if (!('hrcSeq' in event)) return
      if (!this.activation.allowlist.has(event.eventKind)) return
      const task = this.emit(event).catch((error) => {
        // Belt and braces: emit() already swallows everything it can name.
        writeServerLog('WARN', 'acp_event_bridge.observe_failed', {
          eventKind: event.eventKind,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      this.inFlight.add(task)
      void task.finally(() => this.inFlight.delete(task))
    } catch (error) {
      writeServerLog('WARN', 'acp_event_bridge.observe_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Await any in-flight emissions. Test/shutdown affordance only. */
  async drain(): Promise<void> {
    await Promise.all([...this.inFlight])
  }

  private async emit(event: HrcLifecycleEvent): Promise<void> {
    // Detach from the caller's synchronous frame first. A notifier that runs
    // inside a sqlite transaction has committed by the time this resumes, so
    // "post-commit observer" holds no matter who calls notifyEvent.
    await Promise.resolve()
    if (!this.activation.enabled) return

    const origin = resolveBridgedOrigin(
      event.runId === undefined ? null : this.deps.db.runs.getByRunId(event.runId)
    )
    const envelope = buildAcpBridgeEnvelope({
      event,
      nodeId: this.activation.nodeId,
      origin,
    })
    if (envelope === null) {
      writeServerLog('WARN', 'acp_event_bridge.unaddressable_event', {
        eventKind: event.eventKind,
        hrcSeq: event.hrcSeq,
      })
      return
    }

    if (!this.admit(envelope)) return

    const outcome = await this.deliver(envelope)
    if (!outcome.delivered) {
      // Final failure is a WARN and nothing more. The durable fact is the
      // ledger row that produced this envelope; automation degrades, the
      // record does not.
      writeServerLog('WARN', 'acp_event_bridge.delivery_failed', {
        eventId: envelope.event_id,
        event: envelope.event,
        scopeRef: envelope.payload.scopeRef,
        attempts: outcome.attempts,
        error: outcome.error,
      })
      return
    }
    writeServerLog('INFO', 'acp_event_bridge.delivered', {
      eventId: envelope.event_id,
      event: envelope.event,
      scopeRef: envelope.payload.scopeRef,
      attempts: outcome.attempts,
    })
  }

  /**
   * Layer 3 of loop control: the PRODUCER bound, independent of any consumer
   * policy. A misconfigured job — origin policy wide open, no cooldown — can
   * still not turn a flapping runtime into an unbounded mint loop, because the
   * slot is claimed here, durably, before anything is sent.
   */
  private admit(envelope: AcpWebhookEnvelope): boolean {
    if (!this.activation.enabled) return false
    const nowMs = Date.parse(this.now())
    const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now())
    const scopeRef = envelope.payload.scopeRef
    try {
      this.deps.db.acpBridgeEmissions.pruneBefore(
        new Date(now.getTime() - ACP_EVENT_RETENTION_MS).toISOString()
      )
      const windowStart = new Date(now.getTime() - ACP_EVENT_RATE_WINDOW_MS).toISOString()
      const used = this.deps.db.acpBridgeEmissions.countSince(scopeRef, envelope.event, windowStart)
      if (used >= this.activation.rateCapPerWindow) {
        writeServerLog('WARN', 'acp_event_bridge.rate_capped', {
          eventId: envelope.event_id,
          event: envelope.event,
          scopeRef,
          used,
          cap: this.activation.rateCapPerWindow,
          windowStart,
        })
        return false
      }
      // A re-emission of the SAME fact must not consume a second slot; the
      // insert is keyed by canonical event id, so `false` here means we already
      // counted this one and are simply retrying delivery.
      this.deps.db.acpBridgeEmissions.claim({
        eventId: envelope.event_id,
        scopeRef,
        event: envelope.event,
        emittedAt: now.toISOString(),
      })
      return true
    } catch (error) {
      // The rate ledger is the bound, not the fact. If it cannot be consulted
      // we decline to emit rather than emit unbounded.
      writeServerLog('WARN', 'acp_event_bridge.rate_ledger_failed', {
        eventId: envelope.event_id,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * Bounded best-effort delivery: at most 3 attempts inside a 5s wall-clock
   * budget, jittered backoff between them. A 4xx is a contract failure, not a
   * transient one — retrying it would only repeat a rejected envelope, so it
   * stops immediately and reports.
   */
  private async deliver(envelope: AcpWebhookEnvelope): Promise<AcpBridgeDeliveryOutcome> {
    if (!this.activation.enabled) return { delivered: false, attempts: 0, error: 'disabled' }
    const url = this.activation.url
    const startedAt = Date.now()
    let lastError = 'no attempt made'

    for (let attempt = 1; attempt <= ACP_BRIDGE_DELIVERY_ATTEMPTS; attempt += 1) {
      const remaining = ACP_BRIDGE_DELIVERY_BUDGET_MS - (Date.now() - startedAt)
      if (remaining <= 0) {
        return { delivered: false, attempts: attempt - 1, error: `${lastError} (budget exhausted)` }
      }
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(remaining),
        })
        if (response.ok) return { delivered: true, attempts: attempt }
        lastError = `HTTP ${response.status}`
        if (response.status >= 400 && response.status < 500) {
          return { delivered: false, attempts: attempt, error: `${lastError} (not retryable)` }
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }

      if (attempt < ACP_BRIDGE_DELIVERY_ATTEMPTS) {
        const backoff = ACP_BRIDGE_BASE_BACKOFF_MS * 2 ** (attempt - 1)
        const left = ACP_BRIDGE_DELIVERY_BUDGET_MS - (Date.now() - startedAt)
        if (left <= 0) {
          return { delivered: false, attempts: attempt, error: `${lastError} (budget exhausted)` }
        }
        await this.sleep(Math.min(Math.floor(backoff * (0.5 + this.jitter())), left))
      }
    }

    return { delivered: false, attempts: ACP_BRIDGE_DELIVERY_ATTEMPTS, error: lastError }
  }
}
