import { BrokerErrorCode, SUPPORTED_BROKER_PROTOCOL_VERSIONS, validateCommand, validateInvocationDispatchRequest, } from 'spaces-harness-broker-protocol';
import { createDriverRegistry } from './drivers/registry';
import { BrokerError, toInvalidParamsBrokerError } from './errors';
import { createInvocationEventSequencer } from './events';
import { createInvocationManager } from './invocation-manager';
import { parseDispatchEnv } from './runtime/env';
const BROKER_VERSION = '0.1.0';
export function createBroker(options) {
    const { drivers, now = () => new Date() } = options;
    const registry = createDriverRegistry(drivers);
    const sequencer = createInvocationEventSequencer({ now });
    const eventLedger = options.eventLedger;
    const attachIdentity = options.attachIdentity;
    const brokerInstanceId = options.brokerInstanceId ?? `broker_${process.pid}`;
    const baseOnEvent = options.onEvent ?? (() => { });
    // Persist before notifying: the ledger's synchronous append runs before the
    // client sees the event, so a reconnecting controller can always replay it.
    const onEvent = eventLedger
        ? (event) => {
            eventLedger.append(event).catch(() => { });
            baseOnEvent(event);
        }
        : baseOnEvent;
    const advertisedTransports = options.advertisedTransports ?? [
        'stdio-jsonrpc-ndjson',
    ];
    const advertiseAttachReplay = options.advertiseAttachReplay ?? false;
    let clientCapabilities = {};
    const manager = createInvocationManager({
        sequencer,
        onEvent,
        getClientCapabilities: () => clientCapabilities,
        onPermissionRequest: options.onPermissionRequest,
        maxInputQueueDepth: options.maxInputQueueDepth,
        now,
    });
    function requireManagedInvocation(invocationId) {
        const inv = manager.get(invocationId);
        if (!inv) {
            throw new BrokerError(BrokerErrorCode.UnknownInvocation, `Unknown invocation: ${invocationId}`, { invocationId });
        }
        return inv;
    }
    async function buildSnapshot(invocationId, opts) {
        const inv = requireManagedInvocation(invocationId);
        // Snapshot delegates the shared inspection fields to the single read-model
        // helper, then APPENDS reconnect-only state (pending inputs/permissions,
        // input dispositions, retention floor). currentSeq comes from the durable
        // ledger when present (the reconnect cursor), falling back to the projected
        // seq for the stdio path.
        const summary = manager.buildInspectionSummary(invocationId, opts);
        const currentSeq = eventLedger?.currentSeq(invocationId) ?? summary.currentSeq ?? 0;
        const retentionFloorSeq = eventLedger ? await eventLedger.retentionFloorSeq(invocationId) : 0;
        const inputDispositions = {};
        for (const [inputId, record] of inv.inputDispositions) {
            inputDispositions[inputId] = record.response;
        }
        // Broker-owned pending permission requests, each carrying its ABSOLUTE
        // deadline so a reconnecting controller can render the remaining time (C2).
        const pendingPermissionRequests = Array.from(inv.pendingPermissions.values()).map((record) => ({
            ...record.params,
            deadlineAt: record.deadlineAt,
        }));
        return {
            ...summary,
            capabilities: inv.capabilities,
            pendingInputIds: inv.pending.map((item) => item.inputId),
            inputDispositions,
            pendingPermissionRequests,
            process: {
                brokerPid: process.pid,
                ...(inv.childPid !== undefined ? { childPid: inv.childPid } : {}),
                ...(inv.exitCode !== undefined ? { exitCode: inv.exitCode } : {}),
                ...(inv.signal !== undefined ? { signal: inv.signal } : {}),
            },
            currentSeq,
            retentionFloorSeq,
            ...(inv.currentTurnId !== undefined ? { currentTurnId: inv.currentTurnId } : {}),
            ...(inv.continuation !== undefined ? { continuation: inv.continuation } : {}),
        };
    }
    return {
        async hello(req) {
            validateBrokerParams('broker.hello', req);
            const protocolVersion = [...SUPPORTED_BROKER_PROTOCOL_VERSIONS]
                .reverse()
                .find((version) => req.protocolVersions.includes(version));
            if (!protocolVersion) {
                throw new BrokerError(BrokerErrorCode.UnsupportedCapability, 'No supported protocol version in request');
            }
            // Store client capabilities for permission negotiation
            clientCapabilities = req.capabilities ?? {};
            const hasPermissionRequests = clientCapabilities.permissionRequests === true;
            return {
                brokerInfo: {
                    name: 'harness-broker',
                    version: BROKER_VERSION,
                },
                protocolVersion,
                capabilities: {
                    multiInvocation: false,
                    transports: [...advertisedTransports],
                    eventNotifications: true,
                    brokerToClientRequests: hasPermissionRequests,
                    ...(advertiseAttachReplay ? { attachReplay: true } : {}),
                    // Inspection read-model (T-01851): advertise truthfully. This phase
                    // implements listInvocations, timestamps, lifecycle view, cached
                    // liveness, and the eventsSince type filter.
                    inspection: {
                        listInvocations: true,
                        timestamps: true,
                        lifecycleView: true,
                        liveness: 'cached',
                        eventTypeFilter: true,
                    },
                },
                drivers: registry.summaries(),
            };
        },
        async health(req) {
            validateBrokerParams('broker.health', req);
            return {
                status: 'ok',
                activeInvocations: manager.activeCount(),
            };
        },
        start(req, dispatchEnv, runtime, lifecyclePolicy) {
            let parsedDispatchEnv;
            try {
                parsedDispatchEnv = parseDispatchEnv(dispatchEnv, req.spec.process.lockedEnv);
            }
            catch (err) {
                return Promise.reject(err);
            }
            try {
                validateInvocationDispatchRequest({
                    startRequest: req,
                    ...(parsedDispatchEnv !== undefined ? { dispatchEnv: parsedDispatchEnv } : {}),
                    ...(runtime !== undefined ? { runtime } : {}),
                    ...(lifecyclePolicy !== undefined ? { lifecyclePolicy } : {}),
                });
            }
            catch (err) {
                return Promise.reject(toInvalidParamsBrokerError(err) ?? err);
            }
            const driverKind = req.spec.harness.driver;
            const driver = registry.get(driverKind);
            if (!driver) {
                return Promise.reject(new BrokerError(BrokerErrorCode.DriverUnavailable, `No driver registered for kind: ${driverKind}`, { driverKind }));
            }
            // Non-async wrapper: the returned promise has a no-op catch pre-attached
            // so that bun's test runner doesn't flag it as an unhandled rejection when
            // the startup timeout fires before the caller awaits.
            const result = manager.start(req.spec, driver, req.initialInput, parsedDispatchEnv, runtime, lifecyclePolicy);
            result.catch(() => { });
            return result;
        },
        input(req) {
            try {
                validateBrokerParams('invocation.input', req);
            }
            catch (err) {
                return Promise.reject(toInvalidParamsBrokerError(err) ?? err);
            }
            // Non-async: suppress unhandled rejection for turn timeout scenarios
            const result = manager.input(req);
            result.catch(() => { });
            return result;
        },
        async interrupt(req) {
            validateBrokerParams('invocation.interrupt', req);
            return manager.interrupt(req);
        },
        async stop(req) {
            validateBrokerParams('invocation.stop', req);
            return manager.stop(req);
        },
        async status(req) {
            validateBrokerParams('invocation.status', req);
            return manager.status(req.invocationId, req.probeLiveness !== undefined ? { probeLiveness: req.probeLiveness } : undefined);
        },
        async listInvocations(req) {
            validateBrokerParams('broker.listInvocations', req);
            return manager.listInvocations(req);
        },
        async dispose(req) {
            validateBrokerParams('invocation.dispose', req);
            return manager.dispose(req);
        },
        async attach(req) {
            validateBrokerParams('broker.attach', req);
            // Launch identity + attach token must match the runtime this broker was
            // started for. Any mismatch is AttachRejected (no information leak about
            // which field failed beyond the data bag).
            if (attachIdentity !== undefined &&
                (req.runtimeId !== attachIdentity.runtimeId ||
                    req.hostSessionId !== attachIdentity.hostSessionId ||
                    req.generation !== attachIdentity.generation ||
                    req.attachToken !== attachIdentity.attachToken)) {
                throw new BrokerError(BrokerErrorCode.AttachRejected, 'Attach rejected: runtime identity or attach token mismatch', { runtimeId: req.runtimeId, generation: req.generation });
            }
            const inv = manager.get(req.invocationId);
            if (!inv) {
                throw new BrokerError(BrokerErrorCode.AttachRejected, `Attach rejected: unknown invocation ${req.invocationId}`, { invocationId: req.invocationId });
            }
            // Per-invocation request/profile hashes must match the started invocation.
            const correlation = inv.spec.correlation;
            const correlatedStartHash = correlation?.['startRequestHash'];
            const correlatedProfileHash = correlation?.['selectedProfileHash'];
            if ((correlatedStartHash !== undefined && req.startRequestHash !== correlatedStartHash) ||
                (correlatedProfileHash !== undefined && req.selectedProfileHash !== correlatedProfileHash)) {
                throw new BrokerError(BrokerErrorCode.AttachRejected, 'Attach rejected: start-request or profile hash mismatch', { invocationId: req.invocationId });
            }
            const snapshot = await buildSnapshot(req.invocationId);
            return {
                attached: true,
                brokerInstanceId,
                runtimeId: req.runtimeId,
                generation: req.generation,
                invocationId: req.invocationId,
                activeControllerInstanceId: req.controllerInstanceId,
                currentSeq: snapshot.currentSeq,
                retentionFloorSeq: snapshot.retentionFloorSeq,
                snapshot,
            };
        },
        async snapshot(req) {
            validateBrokerParams('invocation.snapshot', req);
            return buildSnapshot(req.invocationId, req.probeLiveness !== undefined ? { probeLiveness: req.probeLiveness } : undefined);
        },
        async eventsSince(req) {
            validateBrokerParams('invocation.eventsSince', req);
            if (!eventLedger) {
                throw new BrokerError(BrokerErrorCode.EventReplayUnavailable, 'Event replay unavailable: no durable ledger configured', { invocationId: req.invocationId });
            }
            // eventsSince rejects below the retention floor (EventReplayUnavailable).
            const replayed = await eventLedger.eventsSince(req.invocationId, req.afterSeq);
            // request.types filters ONLY the returned events. currentSeq and the
            // retention floor still describe the FULL ledger so a reconnecting client
            // advances safely past event types it did not ask to render.
            const events = req.types !== undefined
                ? replayed.filter((event) => req.types?.includes(event.type))
                : replayed;
            const currentSeq = eventLedger.currentSeq(req.invocationId);
            const retentionFloorSeq = await eventLedger.retentionFloorSeq(req.invocationId);
            return { events, currentSeq, retentionFloorSeq };
        },
        async ackEvents(req) {
            validateBrokerParams('invocation.ackEvents', req);
            if (!eventLedger) {
                throw new BrokerError(BrokerErrorCode.EventReplayUnavailable, 'Event ack unavailable: no durable ledger configured', { invocationId: req.invocationId });
            }
            // Monotonic per invocation; controller-fencing is enforced by the caller.
            return eventLedger.ackEvents(req.invocationId, req.throughSeq);
        },
        async permissionRespond(req) {
            validateBrokerParams('invocation.permission.respond', req);
            return manager.permissionRespond(req);
        },
    };
}
function validateBrokerParams(method, params) {
    try {
        validateCommand({ jsonrpc: '2.0', id: 'broker_facade_validation', method, params });
    }
    catch (err) {
        throw toInvalidParamsBrokerError(err) ?? err;
    }
}
//# sourceMappingURL=broker.js.map