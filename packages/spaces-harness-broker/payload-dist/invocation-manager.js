import { BrokerErrorCode, acceptedLifecyclePolicy } from 'spaces-harness-broker-protocol';
import { BrokerError } from './errors';
import { stableJsonStringify } from './event-ledger';
import { normalizeEventPayload } from './runtime/event-normalize';
// ---------------------------------------------------------------------------
// Reason-string vocabulary (centralized for spec traceability)
// ---------------------------------------------------------------------------
const REASON_BUSY_REJECTED = 'busy_rejected';
const REASON_QUEUE_FULL = 'queue_full';
const REASON_QUEUE_NOT_SUPPORTED = 'queue_not_supported';
const REASON_UNSUPPORTED_INPUT_KIND = 'unsupported_input_kind_for_queue';
const REASON_UNSUPPORTED_BUSY_POLICY = 'unsupported_busy_policy';
const REASON_INVOCATION_TERMINATED = 'invocation_terminated';
const REASON_INVOCATION_STOPPING = 'invocation_stopping';
const DEFAULT_MAX_INPUT_QUEUE_DEPTH = 64;
/** Fallback bound for a broker-owned permission deadline when the policy omits one. */
const DEFAULT_PERMISSION_TIMEOUT_MS = 1000;
/** Terminal states that allow dispose. */
const TERMINAL_STATES = new Set(['exited', 'failed']);
/**
 * continuation.cleared reasons that mean the operator LEFT the session (vs.
 * `clear`, which keeps it). On these the broker pushes a final invocation.summary
 * so a shutdown report is recorded on the durable stream before the lease reap.
 * Mirrors HRC's BROKER_TMUX_PROMPT_EXIT_REASONS.
 */
const SESSION_LEAVE_REASONS = new Set(['prompt_input_exit', 'logout']);
/**
 * Reason/message surfaced when a JSON Schema response format is sent to a driver
 * that does not advertise structured final-response support (T-03779).
 */
const REASON_UNSUPPORTED_FINAL_RESPONSE = 'UnsupportedCapability: finalResponse.jsonSchema';
/**
 * Normalize a per-turn response format for idempotency fingerprinting (T-03779):
 * omitted and `{ kind: 'text' }` both collapse to `null`; a JSON Schema format
 * keeps its `{ kind, schema }`. `stableJsonStringify` canonicalizes object key
 * order downstream, so reordered schema keys fingerprint identically.
 */
function normalizeResponseFormat(responseFormat) {
    if (responseFormat?.kind === 'json_schema') {
        return { kind: 'json_schema', schema: responseFormat.schema };
    }
    return null;
}
/** True when this input requests a JSON Schema structured final response. */
function requestsJsonSchemaResponse(input) {
    return input.responseFormat?.kind === 'json_schema';
}
/** True when the driver capabilities advertise per-turn JSON Schema support. */
function supportsJsonSchemaResponse(capabilities) {
    return (capabilities.finalResponse?.jsonSchema === true && capabilities.finalResponse?.perTurn === true);
}
function assertLifecyclePolicySupported(policy, capabilities) {
    if (policy === undefined)
        return;
    const missing = [];
    if (!capabilities.lifecycle.runtimeRetention.includes(policy.retention.mode)) {
        missing.push(`retention.${policy.retention.mode}`);
    }
    if (!capabilities.lifecycle.harnessRecovery.includes(policy.harnessRecovery.mode)) {
        missing.push(`harnessRecovery.${policy.harnessRecovery.mode}`);
    }
    if (!capabilities.lifecycle.turnRetry.includes(policy.turnRetry.mode)) {
        missing.push(`turnRetry.${policy.turnRetry.mode}`);
    }
    if (missing.length > 0) {
        throw new BrokerError(BrokerErrorCode.BrokerLifecyclePolicyUnsupported, 'Broker lifecycle policy unsupported by selected driver capabilities', {
            code: 'broker-lifecycle-policy-unsupported',
            policyId: policy.policyId,
            policyHash: policy.policyHash,
            missing,
            capabilities: capabilities.lifecycle,
        });
    }
}
export function createInvocationManager(options) {
    const { sequencer, onEvent, getClientCapabilities = () => ({}), onPermissionRequest } = options;
    const now = options.now ?? (() => new Date());
    const maxQueueDepth = options.maxInputQueueDepth ?? DEFAULT_MAX_INPUT_QUEUE_DEPTH;
    const invocations = new Map();
    function requireInvocation(invocationId) {
        const inv = invocations.get(invocationId);
        if (!inv) {
            throw new BrokerError(BrokerErrorCode.UnknownInvocation, `Unknown invocation: ${invocationId}`, { invocationId });
        }
        return inv;
    }
    // ---------------------------------------------------------------------------
    // Drain logic — promise-guarded, at most one drain in flight per ready window
    // ---------------------------------------------------------------------------
    function scheduleDrain(inv) {
        if (inv.drainPromise)
            return;
        if (inv.pending.length === 0)
            return;
        if (inv.state !== 'ready')
            return;
        inv.drainPromise = doDrain(inv).finally(() => {
            inv.drainPromise = undefined;
            // Reschedule if invocation is still ready with pending inputs — prevents
            // stalling when a mid-drain failure leaves items in the queue.
            if (inv.state === 'ready' && inv.pending.length > 0) {
                scheduleDrain(inv);
            }
        });
    }
    async function doDrain(inv) {
        while (inv.pending.length > 0 && inv.state === 'ready') {
            const head = inv.pending.shift();
            if (head === undefined)
                return;
            try {
                await applyAndEmit(inv, head.input);
            }
            catch (err) {
                // Input failed at the driver level — reject this item and continue
                // draining; the while-loop guard re-checks state before the next item.
                emit(inv, 'input.rejected', {
                    inputId: head.inputId,
                    reason: String(err instanceof Error ? err.message : err),
                }, { inputId: head.inputId });
            }
        }
    }
    /**
     * Emit broker-owned input.accepted, then call driver.applyInputNow, then
     * GUARANTEE the `turn.started` bracket from the returned turnId (T-04846).
     *
     * The broker no longer depends on a driver hook (e.g. Claude
     * `UserPromptSubmit`) to open the turn: that hook does not fire for an idle
     * dispatch, leaving the turn body/terminal orphaned with no open bracket.
     * Instead, once the input is delivered and `applyInputNow` returns the
     * authoritative turnId, the broker synthesizes exactly one `turn.started`
     * (provenance `source:'broker-delivery'`) BEFORE any body/terminal event.
     * If the driver/hook ALSO observes the start for the same turnId, `emit`
     * dedupes it (whichever path lands first wins). This is the single code path
     * for both immediate application and drain. `attempted_steer` does not flow
     * through here, so it never gets a synthetic start.
     */
    async function applyAndEmit(inv, input) {
        // Broker owns input.accepted emission — before the driver applies the input
        const { inputId } = input;
        emit(inv, 'input.accepted', { inputId, disposition: 'started' }, { inputId });
        const result = await inv.driver.applyInputNow(input);
        // Broker-guaranteed turn.started: synthesize the bracket from the delivered
        // input's turnId. Deduped in emit() so it never double-opens a turn the
        // driver/hook also reports. Emitted synchronously after delivery so it
        // strictly precedes the (asynchronously-arriving) hook body/terminal events.
        if (result.turnId !== undefined) {
            emit(inv, 'turn.started', { turnId: result.turnId, source: 'broker-delivery', inputId }, { turnId: result.turnId, inputId });
        }
        return result;
    }
    async function attemptSteerAndEmit(inv, input) {
        const applySteerNow = inv.driver.applySteerNow;
        if (applySteerNow === undefined) {
            return rejectQueueInput(inv, input.inputId, REASON_QUEUE_NOT_SUPPORTED);
        }
        // Serialize pane writes only. This does not create a broker-owned pending
        // turn, and it never retroactively upgrades the request to `started`.
        const previous = inv.steerPromise ?? Promise.resolve();
        const run = previous
            .catch(() => undefined)
            .then(async () => {
            try {
                await applySteerNow.call(inv.driver, input);
            }
            catch (err) {
                return rejectQueueInput(inv, input.inputId, String(err instanceof Error ? err.message : err));
            }
            emit(inv, 'input.accepted', { inputId: input.inputId, disposition: 'attempted_steer' }, { inputId: input.inputId });
            return {
                inputId: input.inputId,
                accepted: true,
                disposition: 'attempted_steer',
            };
        });
        const tail = run.then(() => undefined, () => undefined);
        inv.steerPromise = tail;
        try {
            return await run;
        }
        finally {
            if (inv.steerPromise === tail) {
                inv.steerPromise = undefined;
            }
        }
    }
    function rejectQueueInput(inv, inputId, reason) {
        emit(inv, 'input.rejected', { inputId, reason }, { inputId });
        return {
            inputId,
            accepted: false,
            disposition: 'rejected',
            reason,
        };
    }
    // ---------------------------------------------------------------------------
    // Queue eviction — reject all pending when invocation terminates or stops
    // ---------------------------------------------------------------------------
    function evictQueue(inv, reason) {
        while (inv.pending.length > 0) {
            const item = inv.pending.shift();
            if (item === undefined)
                return;
            emit(inv, 'input.rejected', { inputId: item.inputId, reason }, { inputId: item.inputId });
        }
    }
    async function handleQueueWhenBusy({ inv, input, inputId, req, }) {
        // Only 'user' kind can be queued
        if (input.kind !== 'user') {
            return rejectQueueInput(inv, inputId, REASON_UNSUPPORTED_INPUT_KIND);
        }
        // Check composed queue capability
        const queueEnabled = inv.spec.interaction?.inputQueue === 'fifo' && inv.capabilities.input.queue === true;
        if (!queueEnabled) {
            return rejectQueueInput(inv, inputId, REASON_QUEUE_NOT_SUPPORTED);
        }
        if (inv.spec.interaction?.mode === 'interactive' && inv.driver.applySteerNow !== undefined) {
            const response = await attemptSteerAndEmit(inv, input);
            recordDisposition(inv, req, response);
            return response;
        }
        // Check depth cap
        if (inv.pending.length >= maxQueueDepth) {
            return rejectQueueInput(inv, inputId, REASON_QUEUE_FULL);
        }
        // Enqueue
        inv.pending.push({ inputId, input });
        emit(inv, 'input.queued', { inputId, disposition: 'queued' }, { inputId });
        const response = {
            inputId,
            accepted: true,
            disposition: 'queued',
        };
        recordDisposition(inv, req, response);
        return response;
    }
    const busyPolicyHandlers = {
        reject: async ({ inv, inputId }) => {
            emit(inv, 'input.rejected', { inputId, reason: REASON_BUSY_REJECTED }, { inputId });
            throw new BrokerError(BrokerErrorCode.InputRejected, REASON_BUSY_REJECTED, {
                invocationId: inv.invocationId,
            });
        },
        // interrupt_then_apply is centrally rejected in v1.
        interrupt_then_apply: async ({ inv, inputId }) => rejectQueueInput(inv, inputId, REASON_UNSUPPORTED_BUSY_POLICY),
        queue: handleQueueWhenBusy,
    };
    // ---------------------------------------------------------------------------
    // Event state machine
    // ---------------------------------------------------------------------------
    function applyEventState(inv, event) {
        // Inspection timestamps/seq project on EVERY event (T-01851): startedAt is
        // the first event's time, lastActivityAt/currentSeq track the latest.
        if (inv.startedAt === undefined) {
            inv.startedAt = event.time;
        }
        inv.lastActivityAt = event.time;
        inv.currentSeq = event.seq;
        switch (event.type) {
            case 'invocation.started': {
                // Capture the child pid for the manager-owned status projection.
                const pid = event.payload?.pid;
                if (typeof pid === 'number') {
                    inv.childPid = pid;
                }
                return;
            }
            case 'harness.started': {
                // A real driver-owned harness.started supersedes the broker's synthetic
                // invocation.started fallback and carries generation + child pid.
                inv.harnessStartedSeen = true;
                const payload = event.payload;
                if (typeof payload?.generation === 'number') {
                    inv.currentHarnessGeneration = payload.generation;
                }
                if (typeof payload?.pid === 'number') {
                    inv.childPid = payload.pid;
                }
                return;
            }
            case 'harness.recovery.completed': {
                const payload = event.payload;
                if (typeof payload?.toGeneration === 'number') {
                    inv.currentHarnessGeneration = payload.toGeneration;
                }
                return;
            }
            case 'turn.retry': {
                const payload = event.payload;
                const toAttempt = event.turnAttempt ?? payload?.toAttempt;
                if (typeof toAttempt === 'number') {
                    inv.currentTurnAttempt = toAttempt;
                }
                const toGeneration = event.harnessGeneration ?? payload?.toHarnessGeneration;
                if (typeof toGeneration === 'number') {
                    inv.currentHarnessGeneration = toGeneration;
                }
                return;
            }
            case 'terminal.surface.reported': {
                inv.terminalSurface = event.payload;
                return;
            }
            case 'invocation.ready':
                inv.state = 'ready';
                return;
            case 'input.accepted':
                if (event.payload?.disposition ===
                    'attempted_steer') {
                    return;
                }
                // The input that drives the next turn — cleared when the turn ends.
                if (event.inputId !== undefined) {
                    inv.currentInputId = event.inputId;
                }
                return;
            case 'turn.started': {
                inv.state = 'turn_active';
                if (event.turnId !== undefined) {
                    inv.currentTurnId = event.turnId;
                }
                // Project the active-turn summary fields (event fields first, then
                // payload, then manager-tracked fallbacks).
                const payload = event.payload;
                inv.currentTurnStartedAt = event.time;
                const attempt = event.turnAttempt ?? payload?.turnAttempt;
                inv.currentTurnAttempt = typeof attempt === 'number' ? attempt : 1;
                const generation = event.harnessGeneration;
                if (typeof generation === 'number') {
                    inv.currentHarnessGeneration = generation;
                }
                return;
            }
            // biome-ignore lint/suspicious/noFallthroughSwitchClause: intentional — turn.completed increments the counter then shares the turn-end projection below.
            case 'turn.completed':
                inv.turnsCompleted = (inv.turnsCompleted ?? 0) + 1;
            // falls through to the shared turn-end projection below
            case 'turn.failed':
            case 'turn.interrupted':
                inv.currentTurnId = undefined;
                inv.currentInputId = undefined;
                inv.currentTurnStartedAt = undefined;
                if (inv.state !== 'exited' && inv.state !== 'failed' && inv.state !== 'disposed') {
                    inv.state = 'ready';
                }
                // Schedule drain if there are pending inputs and we transitioned to ready
                scheduleDrain(inv);
                return;
            case 'invocation.stopping':
                inv.state = 'stopping';
                inv.terminalReason = 'stopping';
                evictQueue(inv, REASON_INVOCATION_STOPPING);
                return;
            case 'invocation.exited': {
                inv.state = 'exited';
                inv.terminalEmitted = true;
                inv.terminalReason = 'exited';
                inv.currentTurnId = undefined;
                inv.currentInputId = undefined;
                inv.currentTurnStartedAt = undefined;
                const payload = event.payload;
                if (payload && 'exitCode' in payload) {
                    inv.exitCode = payload.exitCode;
                }
                if (payload && 'signal' in payload) {
                    inv.signal = payload.signal;
                }
                evictQueue(inv, REASON_INVOCATION_TERMINATED);
                return;
            }
            case 'invocation.failed':
                inv.state = 'failed';
                inv.terminalEmitted = true;
                inv.terminalReason = 'failed';
                inv.currentTurnId = undefined;
                inv.currentInputId = undefined;
                inv.currentTurnStartedAt = undefined;
                evictQueue(inv, REASON_INVOCATION_TERMINATED);
                return;
            case 'invocation.disposed':
                inv.state = 'disposed';
                inv.disposedEmitted = true;
                inv.terminalReason = 'disposed';
                inv.currentTurnId = undefined;
                inv.currentInputId = undefined;
                inv.currentTurnStartedAt = undefined;
                return;
            case 'continuation.updated':
                inv.continuation = event.payload;
                return;
            case 'continuation.cleared':
                inv.continuation = undefined;
                return;
        }
    }
    // ---------------------------------------------------------------------------
    // Emit helper
    // ---------------------------------------------------------------------------
    function emit(inv, type, payload, extra) {
        // Exactly-once `turn.started` bracket (T-04846). A turn may be started from
        // two seams — the broker synthesizing it from a delivered input
        // (`source:'broker-delivery'`) and a driver/hook observing the harness open
        // the turn — and both flow through here. Dedupe by turnId so the turn is
        // opened exactly once: the first start wins and is recorded; a later start
        // for the same turn is suppressed (not sequenced, not projected) and the
        // original winning envelope is returned to the (return-ignoring) caller.
        if (type === 'turn.started') {
            const turnId = extra?.turnId ?? payload?.turnId;
            if (turnId !== undefined) {
                const existing = inv.startedTurns.get(turnId);
                if (existing !== undefined) {
                    return existing;
                }
            }
        }
        // Single central event-safety path before sequencing: constrain/normalize
        // well-known payloads and truncate oversized payloads against maxEventBytes.
        const { payload: safePayload, diagnostics } = normalizeEventPayload({
            type,
            payload,
            maxEventBytes: inv.spec.process.limits?.maxEventBytes,
        });
        const event = sequencer.next(inv.invocationId, type, safePayload, extra);
        if (inv.spec.correlation !== undefined) {
            event.correlation = inv.spec.correlation;
        }
        // Record the winning `turn.started` so any subsequent start for this turn
        // (e.g. a hook-observed start after a broker-delivery synthesis) is deduped
        // above and resolves back to this same envelope (T-04846).
        if (type === 'turn.started' && event.turnId !== undefined) {
            inv.startedTurns.set(event.turnId, event);
        }
        applyEventState(inv, event);
        onEvent(event);
        // Follow-on diagnostics (e.g. truncation notices) are emitted as their own
        // events. Their payloads are small, so they never re-trigger truncation.
        if (diagnostics) {
            for (const diagnostic of diagnostics) {
                emit(inv, 'diagnostic', diagnostic, extra);
            }
        }
        // Graceful-exit summary push: on the user-exit continuation.cleared, push one
        // authoritative invocation.summary on the SAME ordered stream — recorded
        // downstream BEFORE the lease is reaped, so the operator shutdown report reads
        // a pushed-and-recorded summary instead of pulling the (by-then gone) live
        // broker read model. Guarded so it fires exactly once per invocation.
        if (type === 'continuation.cleared' && !inv.summaryEmitted) {
            const reason = safePayload?.reason;
            if (typeof reason === 'string' && SESSION_LEAVE_REASONS.has(reason)) {
                inv.summaryEmitted = true;
                emit(inv, 'invocation.summary', {
                    summary: buildInspectionSummary(inv),
                    reason,
                });
            }
        }
        return event;
    }
    function emitTerminal(inv, type, payload) {
        if (inv.terminalEmitted) {
            return;
        }
        inv.terminalEmitted = true;
        emit(inv, type, payload);
    }
    // ---------------------------------------------------------------------------
    // InputId resolution
    // ---------------------------------------------------------------------------
    function resolveInputId(inv, input) {
        if (input.inputId)
            return input.inputId;
        inv.inputCounter += 1;
        return `input_${inv.invocationId}_${inv.inputCounter}`;
    }
    /**
     * Stable fingerprint of an input request's content + policy, used to detect
     * whether a duplicate inputId carries byte-identical payload (idempotent
     * replay) or differing payload (conflict). Keyed externally by inputId, so
     * the fingerprint deliberately ignores the inputId itself.
     */
    function fingerprintInput(req) {
        return stableJsonStringify({
            kind: req.input.kind,
            content: req.input.content,
            policy: req.policy ?? null,
            responseFormat: normalizeResponseFormat(req.input.responseFormat),
        });
    }
    /** Persist a resolved disposition for a client-provided inputId (idempotency). */
    function recordDisposition(inv, req, response) {
        if (req.input.inputId === undefined)
            return;
        inv.inputDispositions.set(req.input.inputId, {
            fingerprint: fingerprintInput(req),
            response,
        });
    }
    // ---------------------------------------------------------------------------
    // Broker-owned permission lifecycle (C2)
    // ---------------------------------------------------------------------------
    /**
     * Register a broker-owned pending permission request and return a promise that
     * resolves with the FINAL decision. Unlike the JSON-RPC request promise, this
     * pending state is broker-held: it survives controller disconnect and is
     * retained until an absolute `deadlineAt`. It settles exactly once — by the
     * connected client's response (`user`), a reconnected controller's respond
     * (`user`), or deadline expiry applying `defaultDecision` (`timeout`). The
     * `permission.resolved` audit event is emitted on settlement. A failed/closed
     * broker→client request does NOT settle the pending request; it stays pending
     * until the deadline or a respond.
     */
    function brokerRequestPermission(inv, params) {
        const defaultDecision = params.defaultDecision;
        const timeoutMs = params.deadlineMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
        const deadlineAt = new Date(now().getTime() + timeoutMs).toISOString();
        const extra = {
            ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
            ...(inv.currentInputId !== undefined ? { inputId: inv.currentInputId } : {}),
        };
        return new Promise((resolveDriver) => {
            let settled = false;
            const settle = (decision, decidedBy) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                inv.pendingPermissions.delete(params.permissionRequestId);
                inv.settledPermissions.set(params.permissionRequestId, {
                    decision,
                    expired: decidedBy === 'timeout',
                });
                emit(inv, 'permission.resolved', { permissionRequestId: params.permissionRequestId, decision, decidedBy }, extra);
                resolveDriver({ decision });
            };
            // setTimeout/onPermissionRequest are async, so `timer` is always assigned
            // before `settle` (which reads it) can run.
            const timer = setTimeout(() => settle(defaultDecision, 'timeout'), timeoutMs);
            inv.pendingPermissions.set(params.permissionRequestId, {
                params,
                defaultDecision,
                deadlineAt,
                settle,
            });
            // Ask the connected controller. A response settles by `user`; a rejection
            // (controller disconnect / handler error) is intentionally ignored so the
            // request stays pending until the deadline or a reconnect respond.
            if (onPermissionRequest !== undefined) {
                onPermissionRequest(params).then((decision) => settle(decision.decision === 'allow' ? 'allow' : 'deny', 'user'), () => { });
            }
        });
    }
    // ---------------------------------------------------------------------------
    // Inspection read-model (T-01851) — ONE shared summary builder consumed by
    // status(), snapshot/buildSnapshot, and listInvocations so they cannot drift.
    // ---------------------------------------------------------------------------
    function inferDriverHealth(state) {
        switch (state) {
            case 'ready':
            case 'turn_active':
                return 'healthy';
            case 'stopping':
                return 'degraded';
            case 'exited':
            case 'failed':
            case 'disposed':
                return 'exited';
            default:
                return 'unknown';
        }
    }
    function isProcessAlive(state) {
        return state !== 'exited' && state !== 'failed' && state !== 'disposed';
    }
    /** Live-state retention blockers (which conditions hold off idle retirement). */
    function computeRetentionBlockers(inv) {
        const blockers = [];
        if (inv.currentTurnId !== undefined)
            blockers.push('active-turn');
        if (inv.pending.length > 0)
            blockers.push('pending-input');
        if (inv.pendingPermissions.size > 0)
            blockers.push('pending-permission');
        if (inv.state === 'starting' || inv.state === 'stopping')
            blockers.push('not-ready');
        return blockers;
    }
    function buildLifecycleView(inv) {
        const overlay = inv.lifecycleOverlay;
        if (overlay === undefined && inv.terminalReason === undefined) {
            return undefined;
        }
        const blockedBy = computeRetentionBlockers(inv);
        const retention = {
            mode: overlay?.retention.mode ?? 'unknown',
        };
        if (overlay?.retention.mode === 'idle-ttl') {
            const { idleTtlMs } = overlay.retention;
            retention.idleTtlMs = idleTtlMs;
            const idleSince = inv.lastActivityAt;
            if (idleSince !== undefined) {
                retention.idleSince = idleSince;
                // computedRetireAt is only meaningful while nothing blocks retirement.
                if (blockedBy.length === 0) {
                    retention.computedRetireAt = new Date(Date.parse(idleSince) + idleTtlMs).toISOString();
                }
            }
        }
        if (blockedBy.length > 0) {
            retention.blockedBy = blockedBy;
        }
        const harnessRecovery = {
            mode: overlay?.harnessRecovery.mode ?? 'unknown',
        };
        if (inv.currentHarnessGeneration !== undefined) {
            harnessRecovery.currentGeneration = inv.currentHarnessGeneration;
        }
        const turnRetry = {
            mode: overlay?.turnRetry.mode ?? 'unknown',
        };
        if (inv.currentTurnAttempt !== undefined) {
            turnRetry.currentAttempt = inv.currentTurnAttempt;
        }
        const view = { retention, harnessRecovery, turnRetry };
        if (overlay !== undefined) {
            view.policyId = overlay.policyId;
            view.policyHash = overlay.policyHash;
        }
        if (inv.terminalReason !== undefined) {
            view.terminalReason = inv.terminalReason;
        }
        return view;
    }
    function buildCurrentTurn(inv) {
        if (inv.currentTurnId === undefined)
            return undefined;
        const turn = {
            turnId: inv.currentTurnId,
            startedAt: inv.currentTurnStartedAt ?? inv.lastActivityAt ?? inv.startedAt ?? '',
        };
        if (inv.currentInputId !== undefined)
            turn.inputId = inv.currentInputId;
        if (inv.currentTurnAttempt !== undefined)
            turn.attempt = inv.currentTurnAttempt;
        return turn;
    }
    /**
     * Cached liveness view. This phase advertises liveness:'cached' only, so even
     * a probeLiveness request answers from projected facts with mode:'cached' (it
     * never issues tmux/process probes it cannot truthfully perform).
     */
    function buildLivenessView(inv) {
        return {
            mode: 'cached',
            checkedAt: inv.lastActivityAt ?? inv.startedAt ?? '',
            driver: { state: inferDriverHealth(inv.state) },
            process: {
                brokerPid: process.pid,
                ...(inv.childPid !== undefined ? { childPid: inv.childPid } : {}),
                alive: isProcessAlive(inv.state),
                ...(inv.exitCode !== undefined ? { exitCode: inv.exitCode } : {}),
                ...(inv.signal !== undefined ? { signal: inv.signal } : {}),
            },
        };
    }
    function buildInspectionSummary(inv, opts) {
        const summary = {
            invocationId: inv.invocationId,
            state: inv.state,
            driver: inv.driver.kind,
            startedAt: inv.startedAt ?? inv.lastActivityAt ?? '',
            lastActivityAt: inv.lastActivityAt ?? inv.startedAt ?? '',
        };
        if (inv.turnsCompleted !== undefined)
            summary.turnsCompleted = inv.turnsCompleted;
        if (inv.currentSeq !== undefined)
            summary.currentSeq = inv.currentSeq;
        // currentTurn is always present (undefined when no turn is active) so a
        // cleared turn is observable as `currentTurn: undefined` rather than a
        // missing key after a terminal transition.
        summary.currentTurn = buildCurrentTurn(inv);
        const lifecycle = buildLifecycleView(inv);
        if (lifecycle !== undefined)
            summary.lifecycle = lifecycle;
        if (inv.terminalSurface !== undefined)
            summary.terminalSurface = inv.terminalSurface;
        if (opts?.probeLiveness === true)
            summary.liveness = buildLivenessView(inv);
        return summary;
    }
    return {
        async start(spec, driver, initialInput, dispatchEnv, runtime, lifecyclePolicy) {
            // Check if there's already an active invocation
            for (const existing of invocations.values()) {
                if (!TERMINAL_STATES.has(existing.state) && existing.state !== 'disposed') {
                    throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'A non-terminal invocation already exists; single-invocation broker rejects concurrent starts', { existingInvocationId: existing.invocationId });
                }
            }
            const invocationId = spec.invocationId ??
                `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            const driverCaps = driver.capabilities();
            assertLifecyclePolicySupported(lifecyclePolicy, driverCaps);
            // T-03779: reject a JSON Schema initialInput on an unsupporting driver
            // BEFORE driver.start and before the invocation is registered, so no
            // input.accepted/input.rejected is emitted and the driver never sees it.
            if (initialInput !== undefined &&
                requestsJsonSchemaResponse(initialInput) &&
                !supportsJsonSchemaResponse(driverCaps)) {
                throw new BrokerError(BrokerErrorCode.UnsupportedCapability, REASON_UNSUPPORTED_FINAL_RESPONSE);
            }
            const composedQueue = driverCaps.input.queue === true &&
                // input.user is a capability-dependency check (queueing requires user-input capability),
                // NOT a second queue flag.
                driverCaps.input.user === true &&
                spec.interaction?.inputQueue === 'fifo';
            const capabilities = {
                ...driverCaps,
                input: {
                    ...driverCaps.input,
                    // Broker-composed: the public surface reflects the composed value,
                    // NOT the raw driver-reported value.
                    queue: composedQueue,
                },
            };
            const inv = {
                invocationId,
                spec,
                state: 'starting',
                capabilities,
                driver,
                terminalEmitted: false,
                disposedEmitted: false,
                pending: [],
                inputCounter: 0,
                inputDispositions: new Map(),
                startedTurns: new Map(),
                pendingPermissions: new Map(),
                settledPermissions: new Map(),
            };
            invocations.set(invocationId, inv);
            const ctx = {
                invocationId,
                clientCapabilities: getClientCapabilities(),
                ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
                ...(runtime !== undefined ? { runtime } : {}),
                emit(type, payload, extra) {
                    return emit(inv, type, payload, extra);
                },
                ...(onPermissionRequest !== undefined
                    ? {
                        // Broker-owned permission lifecycle (C2): the driver hands the
                        // request to the broker, which holds it until an absolute
                        // deadline, survives controller disconnect, emits
                        // permission.resolved, and returns the final decision.
                        requestPermission: (params) => brokerRequestPermission(inv, params),
                        brokerOwnsPermissionLifecycle: true,
                    }
                    : {}),
            };
            if (lifecyclePolicy !== undefined) {
                // Retain the FULL accepted overlay on the record so the inspection
                // lifecycle view can report idle-ttl details without reconstructing them
                // from the accepted-policy event (which only carries the modes).
                inv.lifecycleOverlay = lifecyclePolicy;
                emit(inv, 'lifecycle.policy.accepted', acceptedLifecyclePolicy(lifecyclePolicy));
            }
            try {
                await driver.start(spec, ctx);
            }
            catch (err) {
                inv.state = 'failed';
                emitTerminal(inv, 'invocation.failed', {
                    message: err instanceof Error ? err.message : 'Driver start failed',
                });
                throw err;
            }
            if (!inv.terminalEmitted) {
                // Synthetic invocation.started is a fallback for drivers that do not emit
                // their own harness.started; skip it when a real harness.started arrived.
                if (inv.state === 'starting' && inv.harnessStartedSeen !== true) {
                    emit(inv, 'invocation.started', {
                        command: spec.process.command,
                        args: spec.process.args,
                        cwd: spec.process.cwd,
                    });
                }
                if (inv.state !== 'ready') {
                    emit(inv, 'invocation.ready', { state: 'ready' });
                }
            }
            inv.state = 'ready';
            // Apply initialInput through the same broker-owned path as client.input()
            if (initialInput !== undefined && !inv.terminalEmitted) {
                const inputId = resolveInputId(inv, initialInput);
                const inputWithId = { ...initialInput, inputId };
                await applyAndEmit(inv, inputWithId);
            }
            return {
                invocationId,
                state: inv.state,
                capabilities: inv.capabilities,
                ...(lifecyclePolicy !== undefined
                    ? { acceptedLifecyclePolicy: acceptedLifecyclePolicy(lifecyclePolicy) }
                    : {}),
            };
        },
        async input(req) {
            const inv = requireInvocation(req.invocationId);
            // inputId idempotency: a duplicate client-provided inputId replays the
            // original response when content/policy is byte-identical, or conflicts
            // when it differs. Checked before any state validation so a retry never
            // re-drives a turn or trips a stale-state rejection.
            const providedInputId = req.input.inputId;
            if (providedInputId !== undefined) {
                const existing = inv.inputDispositions.get(providedInputId);
                if (existing !== undefined) {
                    if (existing.fingerprint === fingerprintInput(req)) {
                        return existing.response;
                    }
                    throw new BrokerError(BrokerErrorCode.DuplicateInputConflict, `Duplicate inputId ${providedInputId} differs by content, policy, or responseFormat`, { invocationId: inv.invocationId, inputId: providedInputId });
                }
            }
            // Resolve inputId upfront — stable across all paths
            const rawInput = req.input;
            const inputId = resolveInputId(inv, rawInput);
            const input = { ...rawInput, inputId };
            // Invalid state rejection
            if (inv.state !== 'ready' && inv.state !== 'turn_active') {
                throw new BrokerError(BrokerErrorCode.InvalidInvocationState, `Cannot accept input in state: ${inv.state}`, { invocationId: inv.invocationId, state: inv.state });
            }
            if (input.kind === 'steer' && !inv.capabilities.input.steer) {
                emit(inv, 'input.rejected', { inputId, reason: 'UnsupportedCapability: input.steer' }, { inputId });
                throw new BrokerError(BrokerErrorCode.UnsupportedCapability, 'UnsupportedCapability: input.steer');
            }
            if (input.kind === 'append_context' && !inv.capabilities.input.appendContext) {
                emit(inv, 'input.rejected', { inputId, reason: 'UnsupportedCapability: input.appendContext' }, { inputId });
                throw new BrokerError(BrokerErrorCode.UnsupportedCapability, 'UnsupportedCapability: input.appendContext');
            }
            // T-03779: a JSON Schema response format is accepted only when the driver
            // advertises per-turn structured support. Reject before input.accepted,
            // queueing, or driver apply.
            if (requestsJsonSchemaResponse(input) && !supportsJsonSchemaResponse(inv.capabilities)) {
                emit(inv, 'input.rejected', { inputId, reason: REASON_UNSUPPORTED_FINAL_RESPONSE }, { inputId });
                throw new BrokerError(BrokerErrorCode.UnsupportedCapability, REASON_UNSUPPORTED_FINAL_RESPONSE);
            }
            // --- State: ready → apply immediately ---
            if (inv.state === 'ready') {
                const result = await applyAndEmit(inv, input);
                const response = {
                    inputId,
                    accepted: true,
                    disposition: 'started',
                    turnId: result.turnId,
                };
                recordDisposition(inv, req, response);
                return response;
            }
            // --- State: turn_active → policy-driven ---
            const policy = req.policy;
            // Default: no policy → reject (legacy behavior)
            if (!policy) {
                throw new BrokerError(BrokerErrorCode.InputRejected, 'Input rejected: turn already active (no policy specified)', { invocationId: inv.invocationId });
            }
            const handler = busyPolicyHandlers[policy.whenBusy];
            if (handler === undefined) {
                throw new BrokerError(BrokerErrorCode.InputRejected, `Unknown whenBusy policy: ${policy.whenBusy}`, { invocationId: inv.invocationId });
            }
            return handler({ inv, input, inputId, req });
        },
        async interrupt(req) {
            const inv = requireInvocation(req.invocationId);
            if (TERMINAL_STATES.has(inv.state) || inv.state === 'disposed') {
                return { accepted: false, effect: 'no_active_turn', reason: `Invocation is ${inv.state}` };
            }
            return inv.driver.interrupt(req);
        },
        async stop(req) {
            const inv = requireInvocation(req.invocationId);
            if (TERMINAL_STATES.has(inv.state) || inv.state === 'disposed') {
                return { accepted: false, state: inv.state };
            }
            inv.state = 'stopping';
            emit(inv, 'invocation.stopping', { reason: req.reason });
            const result = await inv.driver.stop(req);
            // Terminal state determined by driver
            const terminalState = result.state === 'failed' ? 'failed' : 'exited';
            inv.state = terminalState;
            if (terminalState === 'failed') {
                emitTerminal(inv, 'invocation.failed', {
                    message: req.reason ?? 'Stopped',
                });
            }
            else {
                emitTerminal(inv, 'invocation.exited', {});
            }
            return { accepted: true, state: inv.state };
        },
        status(invocationId, opts) {
            const inv = requireInvocation(invocationId);
            // status() projects through the shared inspection summary, then layers the
            // status-only fields (capabilities/continuation/process + legacy ids).
            const response = {
                ...buildInspectionSummary(inv, opts),
                capabilities: inv.capabilities,
                continuation: inv.continuation,
            };
            if (inv.currentTurnId !== undefined) {
                response.currentTurnId = inv.currentTurnId;
            }
            if (inv.currentHarnessGeneration !== undefined) {
                response.currentHarnessGeneration = inv.currentHarnessGeneration;
            }
            if (inv.currentTurnAttempt !== undefined) {
                response.currentTurnAttempt = inv.currentTurnAttempt;
            }
            // Project child-process info when any of pid/exitCode/signal is known.
            if (inv.childPid !== undefined || inv.exitCode !== undefined || inv.signal !== undefined) {
                response.process = {
                    ...(inv.childPid !== undefined ? { pid: inv.childPid } : {}),
                    ...(inv.exitCode !== undefined ? { exitCode: inv.exitCode } : {}),
                    ...(inv.signal !== undefined ? { signal: inv.signal } : {}),
                };
            }
            return response;
        },
        async dispose(req) {
            const inv = requireInvocation(req.invocationId);
            // Idempotent: a second dispose neither re-runs the driver nor re-emits.
            if (inv.state === 'disposed' || inv.disposedEmitted) {
                return { disposed: true };
            }
            if (!TERMINAL_STATES.has(inv.state)) {
                throw new BrokerError(BrokerErrorCode.InvalidInvocationState, `Cannot dispose invocation in state: ${inv.state}`, { invocationId: inv.invocationId, state: inv.state });
            }
            await inv.driver.dispose();
            // emit() → applyEventState sets state = 'disposed' and disposedEmitted.
            emit(inv, 'invocation.disposed', { disposed: true });
            return { disposed: true };
        },
        permissionRespond(req) {
            const inv = requireInvocation(req.invocationId);
            const pending = inv.pendingPermissions.get(req.permissionRequestId);
            if (pending !== undefined) {
                // Settle the broker-owned pending request: emits permission.resolved and
                // resolves the driver's awaiting decision.
                pending.settle(req.decision, 'user');
                return {
                    status: 'accepted',
                    permissionRequestId: req.permissionRequestId,
                    decision: req.decision,
                };
            }
            const settled = inv.settledPermissions.get(req.permissionRequestId);
            if (settled === undefined) {
                throw new BrokerError(BrokerErrorCode.UnknownPermissionRequest, `Unknown permission request: ${req.permissionRequestId}`, { invocationId: req.invocationId, permissionRequestId: req.permissionRequestId });
            }
            // Settled by deadline expiry — a respond can no longer take effect.
            if (settled.expired) {
                throw new BrokerError(BrokerErrorCode.PermissionResponseExpired, `Permission request already expired: ${req.permissionRequestId}`, { invocationId: req.invocationId, permissionRequestId: req.permissionRequestId });
            }
            // Already answered: replay the original decision, or conflict on a mismatch.
            if (settled.decision === req.decision) {
                return {
                    status: 'duplicate',
                    permissionRequestId: req.permissionRequestId,
                    originalDecision: settled.decision,
                };
            }
            throw new BrokerError(BrokerErrorCode.PermissionResponseConflict, `Permission request already decided ${settled.decision}; cannot change to ${req.decision}`, {
                invocationId: req.invocationId,
                permissionRequestId: req.permissionRequestId,
                originalDecision: settled.decision,
                attemptedDecision: req.decision,
            });
        },
        get(invocationId) {
            return invocations.get(invocationId);
        },
        buildInspectionSummary(invocationId, opts) {
            return buildInspectionSummary(requireInvocation(invocationId), opts);
        },
        listInvocations(req) {
            const includeDisposed = req.includeDisposed === true;
            const opts = {
                ...(req.probeLiveness !== undefined ? { probeLiveness: req.probeLiveness } : {}),
            };
            const invocationsOut = [];
            for (const inv of invocations.values()) {
                if (inv.state === 'disposed' && !includeDisposed)
                    continue;
                invocationsOut.push(buildInspectionSummary(inv, opts));
            }
            return { invocations: invocationsOut };
        },
        activeCount() {
            let count = 0;
            for (const inv of invocations.values()) {
                if (!TERMINAL_STATES.has(inv.state) && inv.state !== 'disposed') {
                    count++;
                }
            }
            return count;
        },
    };
}
//# sourceMappingURL=invocation-manager.js.map