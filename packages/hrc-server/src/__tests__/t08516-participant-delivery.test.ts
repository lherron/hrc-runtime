/**
 * T-08516 (8504A) — R7.6's linkage checks, one case per check.
 *
 * Astra's correction on EN-12516: my resolver's comment claimed more linkage
 * than its code enforced. Every check below is paired with a case that must go
 * RED if that check is deleted, so the claim and the code cannot drift apart
 * again. `bun test` over this file with any single guard removed fails exactly
 * its own case.
 */

import { describe, expect, test } from 'bun:test'
import { parseScopeRef } from 'agent-scope'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { resolveParticipantDelivery } from '../participant-delivery.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'

const SCOPE = 'agent:arris:project:hrc-runtime:task:T-08516-delivery'
const NOW = '2026-09-15T00:00:00.000Z'

type World = {
  db: HrcDatabase
  server: HrcServerInstanceForHandlers
  session: { hostSessionId: string; scopeRef: string; laneRef: string; generation: number }
}

/**
 * A fully attached, activated DIRECT participant, then mutated per case.
 * Built through the real repositories so the rows obey the real constraints.
 */
function world(
  patch: {
    attempt?: Record<string, unknown>
    binding?: Record<string, unknown>
    runtime?: Record<string, unknown>
    registration?: Record<string, unknown>
    omitBinding?: boolean
    omitRuntime?: boolean
  } = {}
): World {
  const db = openHrcDatabase(':memory:')
  const hostSessionId = 'hsid-delivery'
  const runtimeId = 'rt-delivery'
  const invocationId = 'inv-delivery'

  db.sessions.insert({
    hostSessionId,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    parsedScopeJson: parseScopeRef(SCOPE) as unknown as Record<string, unknown>,
    ancestorScopeRefs: [],
  })
  db.participantHostBindings.insertReservation({
    reservationId: 'resv-delivery',
    scopeRef: SCOPE,
    laneRef: 'main',
    homeNodeId: 'local',
    state: 'held',
    createdAt: NOW,
    updatedAt: NOW,
  })
  db.participantRegistrations.insertRegistration({
    registrationId: 'preg-delivery',
    registrationMode: 'direct',
    join: 'participant-served',
    scopeRef: SCOPE,
    laneRef: 'main',
    hostSessionId,
    generation: 1,
    policy: {
      addressPolicy: 'selected-scope',
      continuityPolicy: 'host-incarnation',
      lifecycleOwner: 'externally-owned',
      replaySemantics: 'full-source-replay',
    },
    hostIncarnationId: 'host-incarnation:delivery',
    createdAt: NOW,
    updatedAt: NOW,
    ...patch.registration,
  } as never)
  if (patch.omitBinding !== true) {
    db.participantHostBindings.insertBinding({
      bindingId: 'bind-delivery',
      reservationId: 'resv-delivery',
      registrationId: 'preg-delivery',
      hostIncarnationId: 'host-incarnation:delivery',
      hostSessionId,
      generation: 1,
      runtimeId,
      state: 'BOUND',
      admittedAt: NOW,
      updatedAt: NOW,
      ...patch.binding,
    } as never)
  }
  db.participantRegistrations.insertAttempt({
    attemptId: 'patt-delivery',
    registrationId: 'preg-delivery',
    attachEpoch: 1,
    requestId: 'req-delivery',
    operationId: 'op-delivery',
    invocationId,
    runtimeId,
    ...(patch.omitBinding === true ? {} : { hostBindingId: 'bind-delivery' }),
    state: 'ACTIVE',
    preparedProfileJson: '{"kind":"harness-broker"}',
    adapterDispatchEnvJson: '{}',
    recoveryDisposition: 'unresolved',
    establishmentWorkState: 'completed',
    establishmentAttemptCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch.attempt,
  } as never)
  if (patch.omitRuntime !== true) {
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      activeInvocationId: invocationId,
      createdAt: NOW,
      updatedAt: NOW,
      ...patch.runtime,
    } as never)
  }
  return {
    db,
    server: { db } as unknown as HrcServerInstanceForHandlers,
    session: { hostSessionId, scopeRef: SCOPE, laneRef: 'main', generation: 1 },
  }
}

function resolve(
  patch: Parameters<typeof world>[0] = {}
): ReturnType<typeof resolveParticipantDelivery> {
  const { db, server, session } = world(patch)
  try {
    return resolveParticipantDelivery(server, session as never)
  } finally {
    db.close()
  }
}

/**
 * Resolve with a controller present, so the reconnect branch is reachable.
 * Without one the predicate answers false and every case reads as attached --
 * which is why the cases above cannot see this branch at all.
 */
function resolveWithController(
  activeInvocationId: string | undefined,
  patch: Parameters<typeof world>[0] = {}
): ReturnType<typeof resolveParticipantDelivery> {
  const { db, server, session } = world(patch)
  const withController = {
    ...server,
    db,
    harnessBrokerController: { activeClientInvocationId: () => activeInvocationId },
  } as unknown as HrcServerInstanceForHandlers
  try {
    return resolveParticipantDelivery(withController, session as never)
  } finally {
    db.close()
  }
}

describe('T-08516 participant delivery linkage (R7.6)', () => {
  test('an ordinary session is not a participant and is left alone', () => {
    const { db, server } = world()
    try {
      expect(
        resolveParticipantDelivery(server, {
          hostSessionId: 'hsid-other',
          scopeRef: 'agent:clod:project:hrc-runtime:task:ordinary',
          laneRef: 'main',
          generation: 1,
        } as never)
      ).toBeNull()
    } finally {
      db.close()
    }
  })

  test('a fully linked, activated participant resolves to its own runtime', () => {
    const delivery = resolve()
    expect(delivery?.outcome).toBe('attached')
    if (delivery?.outcome !== 'attached') return
    expect(delivery.runtime.runtimeId).toBe('rt-delivery')
    expect(delivery.attempt.attemptId).toBe('patt-delivery')
  })

  test('a legacy keyed attempt with no host binding is still valid', () => {
    // R7.6 keeps the legacy path working: it has no binding by construction,
    // so the binding checks must be keyed on presence, not on mode.
    const delivery = resolve({ omitBinding: true })
    expect(delivery?.outcome).toBe('attached')
  })

  describe('controller reconnect (section 6.2)', () => {
    test('a controller already serving this invocation delivers directly', () => {
      const delivery = resolveWithController('inv-delivery')
      expect(delivery?.outcome).toBe('attached')
    })

    test('a controller with no client for it needs reconnect, not a refusal', () => {
      // A restart replaces the controller instance and nothing else. The
      // attempt stays ACTIVE and its work stays `completed`, which is why
      // neither startup enumeration nor the establishment scheduler reached it
      // and a live host stayed unreachable across a restart.
      const delivery = resolveWithController(undefined)
      expect(delivery?.outcome).toBe('reconnect')
    })

    test('a controller holding a client for another invocation also reconnects', () => {
      // The DURABLE linkage is fine here -- the attempt and the runtime agree.
      // What is stale is the controller's client, which is the same condition a
      // restart produces and is repaired the same way. (This case originally
      // asserted a stale-linkage refusal; that was the test being wrong, not
      // the code: stale ROW linkage and a stale CONTROLLER client are different
      // failures with different repairs.)
      const delivery = resolveWithController('inv-someone-else')
      expect(delivery?.outcome).toBe('reconnect')
    })

    test('an unattached attempt is never made reconnectable', () => {
      const delivery = resolveWithController(undefined, {
        attempt: { preparedProfileJson: undefined, adapterDispatchEnvJson: undefined },
      })
      expect(delivery).toMatchObject({ kind: 'pending', reason: 'participant_attachment_pending' })
    })

    test('an exhausted attempt is not reopened by reconnect', () => {
      const delivery = resolveWithController(undefined, {
        attempt: { establishmentWorkState: 'exhausted' },
      })
      // Not `reconnect`: reopening it would reset a budget that is spent.
      expect(delivery?.outcome).toBe('attached')
    })
  })

  describe('pending, not failed', () => {
    test('no frozen profile is attachment pending', () => {
      const delivery = resolve({
        attempt: { preparedProfileJson: undefined, adapterDispatchEnvJson: undefined },
      })
      expect(delivery).toMatchObject({ kind: 'pending', reason: 'participant_attachment_pending' })
    })

    test('attached but not yet ACTIVE is activation pending', () => {
      // The check Astra named: a nonterminal runtime alone is NOT activated
      // attachment. PREPARED means the profile is durable and the host has not
      // confirmed it is serving.
      const delivery = resolve({ attempt: { state: 'PREPARED' } })
      expect(delivery).toMatchObject({ kind: 'pending', reason: 'participant_activation_pending' })
    })

    test('a binding still in BINDING is pending', () => {
      const delivery = resolve({ binding: { state: 'BINDING' } })
      expect(delivery).toMatchObject({ kind: 'pending', reason: 'participant_binding_not_bound' })
    })

    test('a reserved but unmaterialized runtime is pending', () => {
      const delivery = resolve({ omitRuntime: true })
      expect(delivery).toMatchObject({
        kind: 'pending',
        reason: 'participant_runtime_not_materialized',
      })
    })
  })

  describe('stale linkage refuses rather than targeting another writer', () => {
    test('an absorbing attempt will never serve', () => {
      const delivery = resolve({
        attempt: { state: 'ABANDONED', dispositionReason: 'fixture' },
      })
      expect(delivery).toMatchObject({
        kind: 'unavailable',
        reason: 'participant_attempt_absorbing',
      })
    })

    test('a retired binding is refused', () => {
      const delivery = resolve({
        binding: { state: 'RETIRED', retiredAt: NOW, dispositionReason: 'fixture' },
      })
      expect(delivery).toMatchObject({ kind: 'unavailable' })
    })

    test('a binding naming a different incarnation is refused', () => {
      const delivery = resolve({ binding: { hostIncarnationId: 'host-incarnation:someone-else' } })
      expect(delivery).toMatchObject({
        kind: 'unavailable',
        reason: 'participant_linkage_stale',
      })
    })

    test('a binding naming a different runtime is refused', () => {
      const delivery = resolve({ binding: { runtimeId: 'rt-somewhere-else' } })
      expect(delivery).toMatchObject({
        kind: 'unavailable',
        reason: 'participant_linkage_stale',
      })
    })

    test('a runtime serving a different invocation is refused', () => {
      const delivery = resolve({ runtime: { activeInvocationId: 'inv-someone-else' } })
      expect(delivery).toMatchObject({
        kind: 'unavailable',
        reason: 'participant_linkage_stale',
      })
    })

    test('a runtime belonging to another session or generation is refused', () => {
      const delivery = resolve({ runtime: { generation: 7 } })
      expect(delivery).toMatchObject({
        kind: 'unavailable',
        reason: 'participant_linkage_stale',
      })
    })

    test('an unavailable runtime means the host is not serving', () => {
      const delivery = resolve({ runtime: { status: 'terminated' } })
      expect(delivery).toMatchObject({
        kind: 'unavailable',
        reason: 'participant_host_unavailable',
      })
    })
  })
})
