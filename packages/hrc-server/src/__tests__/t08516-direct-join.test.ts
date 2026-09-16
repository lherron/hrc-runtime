/**
 * T-08516 (8504A) — protocol join: a participant registers its own address.
 *
 * Contract `architecture/contracts/host-participant-lifecycle.md` revision 7,
 * R6.1-R6.4 and R7.1-R7.4. Most cases here run with NO participant adapter
 * registered at all, because that is exactly R6.1's claim: joining is a
 * protocol operation, so HRC must not call `admit`, read a host descriptor,
 * request an evidence file or need an adapter to be loadable before it will
 * record an address.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { ParticipantAdapter } from 'spaces-runtime-contracts'

import { createHrcServer } from '../index.js'
import type { HrcServer, HrcServerOptions, RegistrationClassConfig } from '../index.js'
import { ParticipantAdapterRegistry } from '../participant-adapter-registry.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:arris:project:hrc-runtime:task:T-08516'
const OTHER_SCOPE = 'agent:arris:project:hrc-runtime:task:T-08516-other'

type Observed = { status: number; body: Record<string, unknown> }

async function observe(response: Response): Promise<Observed> {
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Keep the literal payload: a missing route answers text/plain, and that
    // difference is exactly what a routing regression should show.
  }
  return { status: response.status, body: body as Record<string, unknown> }
}

/**
 * An adapter that fails loudly if anything touches it during a join.
 *
 * R6.8 case 2 wants proof that `admit` is never called, and the discriminating
 * way to prove it is an adapter that would make the request fail if it were:
 * a spy that merely records a zero call count is also satisfied by an adapter
 * that was never reachable in the first place. `prepare` throws for the same
 * reason -- joining must not run the post-join helper either.
 */
function createExplodingAdapter(adapterId: string): ParticipantAdapter {
  return {
    adapterId,
    admit() {
      throw new Error('admit must never be called on a join path')
    },
    prepare() {
      throw new Error('prepare must never be called during registration')
    },
  } as unknown as ParticipantAdapter
}

describe('T-08516 direct protocol join', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t08516-direct-join-')
  })

  afterEach(async () => {
    await server?.stop()
    server = undefined
    await fixture.cleanup()
  })

  async function start(options: Partial<HrcServerOptions> = {}): Promise<void> {
    server = await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false, registrationClasses: [], ...options })
    )
  }

  function join(body: Record<string, unknown>): Promise<Response> {
    return fixture.postJson('/v1/participants/register', {
      registrationMode: 'direct',
      requestedSessionRef: SCOPE,
      hostIncarnationId: 'incarnation-alpha',
      ...body,
    })
  }

  /** Read the durable rows directly, without going back through the API. */
  function readStore(): {
    registrations: Record<string, unknown>[]
    attempts: Record<string, unknown>[]
    reservations: Record<string, unknown>[]
    bindings: Record<string, unknown>[]
    runtimes: Record<string, unknown>[]
  } {
    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      const all = (sql: string): Record<string, unknown>[] =>
        db.sqlite.query<Record<string, unknown>, []>(sql).all()
      return {
        registrations: all('SELECT * FROM participant_registrations'),
        attempts: all('SELECT * FROM participant_registration_attempts'),
        reservations: all('SELECT * FROM participant_address_reservations'),
        bindings: all('SELECT * FROM participant_host_bindings'),
        runtimes: all('SELECT * FROM runtimes'),
      }
    } finally {
      db.close()
    }
  }

  function setAttemptState(state: string, workState: string): void {
    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      db.sqlite
        .query(
          `UPDATE participant_registration_attempts
              SET state = ?, establishment_work_state = ?`
        )
        .run(state, workState)
    } finally {
      db.close()
    }
  }

  test('a classless participant joins with no adapter installed at all', async () => {
    await start()

    const registered = await observe(await join({}))

    expect(registered.status).toBe(200)
    expect(registered.body).toMatchObject({
      status: 'registered',
      scopeRef: SCOPE,
      generation: 1,
      created: true,
      resumed: false,
      observation: { state: 'attachment_pending' },
      continuation: { carried: false, reason: 'no_continuation', selected: null },
    })
    const identity = registered.body['identity'] as Record<string, string>
    for (const field of ['registrationId', 'runtimeId', 'attemptId', 'invocationId'] as const) {
      expect(typeof identity[field]).toBe('string')
    }
    expect(registered.body['hostSessionId']).toBeString()
    expect(identity['attachEpoch']).toBe(1)
  })

  test('stores the join truthfully: null optional fields and no runtime row', async () => {
    await start()
    await join({})

    const stored = readStore()
    expect(stored.registrations).toHaveLength(1)
    const registration = stored.registrations[0] as Record<string, unknown>
    expect(registration['registration_mode']).toBe('direct')
    expect(registration['host_incarnation_id']).toBe('incarnation-alpha')
    // R7.1: nothing was fabricated for what the participant did not supply.
    expect(registration['class_id']).toBeNull()
    expect(registration['adapter_id']).toBeNull()
    expect(registration['participant_key']).toBeNull()
    expect(registration['workspace_cwd']).toBeNull()
    expect(registration['preparation_json']).toBeNull()
    // R6.2's resolved defaults, stored so a lookup needs no class or adapter.
    expect(registration['address_policy']).toBe('selected-scope')
    expect(registration['continuity_policy']).toBe('host-incarnation')
    expect(registration['lifecycle_owner']).toBe('externally-owned')

    expect(stored.attempts).toHaveLength(1)
    const attempt = stored.attempts[0] as Record<string, unknown>
    expect(attempt['state']).toBe('IDENTITY_MINTED')
    expect(attempt['prepared_profile_json']).toBeNull()
    expect(attempt['adapter_dispatch_env_json']).toBeNull()
    expect(attempt['establishment_work_state']).toBe('pending')
    expect(attempt['host_binding_id']).toBe(stored.bindings[0]?.['binding_id'])

    // R6.3: the runtimeId is reserved as an identifier. Materializing the row
    // would require transport/harness/provider, which are NOT NULL and all
    // profile-derived, so it cannot exist honestly before attachment.
    expect(stored.runtimes).toHaveLength(0)

    expect(stored.reservations).toHaveLength(1)
    expect(stored.reservations[0]?.['state']).toBe('held')
    expect(stored.reservations[0]?.['class_id']).toBeNull()
    expect(stored.bindings).toHaveLength(1)
    expect(stored.bindings[0]?.['state']).toBe('BINDING')
  })

  test('never calls admit or prepare, even with a configured class and adapter', async () => {
    const participantClass = {
      classId: 't08516-class',
      adapterId: 't08516-adapter',
      join: 'participant-served',
      address: 'permanent-keyed',
      continuity: 'key-scoped',
      replaySemantics: 'full-source-replay',
      scopeTemplate: { agent: 'arris', project: 'hrc-runtime' },
      maxInstances: 4,
      defaultTtl: 60,
    }
    await start({
      registrationClasses: [participantClass] as unknown as readonly RegistrationClassConfig[],
      participantAdapterRegistry: new ParticipantAdapterRegistry([
        createExplodingAdapter('t08516-adapter'),
      ]),
    })

    // A direct join naming the class for delivery defaults still never loads it
    // for permission: an adapter identifier is not admission authority.
    const registered = await observe(await join({ classId: 't08516-class' }))
    expect(registered.status).toBe(200)
    expect(registered.body['status']).toBe('registered')

    // And the legacy key-scoped path no longer calls admit either (R6.1/R6.9).
    const legacy = await observe(
      await fixture.postJson('/v1/participants/register', {
        classId: 't08516-class',
        processToken: 'ignored-compatibility-token',
        participantKey: 'legacy-key',
        // The one join-specific shape rule T-08349 already enforced survives.
        socketPath: `${fixture.tmpDir}/legacy-broker.sock`,
      })
    )
    expect(legacy.status).toBe(200)
    expect(legacy.body).toMatchObject({
      status: 'registered',
      observation: { state: 'attachment_pending' },
    })
  })

  test('a duplicate direct request returns the same identities', async () => {
    await start()
    const first = await observe(await join({}))
    const second = await observe(await join({}))

    expect(second.body['created']).toBe(false)
    expect(second.body['identity']).toEqual(first.body['identity'])
    expect(second.body['hostSessionId']).toBe(first.body['hostSessionId'] as string)
    expect(readStore().registrations).toHaveLength(1)
  })

  test('registered-but-unattached survives a daemon restart and stays pending', async () => {
    await start()
    const first = await observe(await join({}))
    await server?.stop()
    server = undefined

    // A second daemon over the same store: the address, its identities and its
    // pending work are read back from disk, not from anything in memory.
    await start()
    const afterRestart = await observe(await join({}))
    expect(afterRestart.body['created']).toBe(false)
    expect(afterRestart.body['identity']).toEqual(first.body['identity'])
    expect(afterRestart.body['observation']).toMatchObject({ state: 'attachment_pending' })

    const stored = readStore()
    expect(stored.attempts[0]?.['establishment_work_state']).toBe('pending')
    // R7.2: waiting for a participant burns no retries.
    expect(stored.attempts[0]?.['establishment_attempt_count']).toBe(0)
    expect(stored.attempts[0]?.['establishment_last_error']).toBeNull()
    expect(stored.runtimes).toHaveLength(0)
  })

  test('IDENTITY_MINTED conflict names the exact predecessor state', async () => {
    await start()
    await join({})
    const before = readStore()

    const intruder = await observe(await join({ hostIncarnationId: 'incarnation-beta' }))
    expect(intruder.status).toBe(409)
    expect(intruder.body).toMatchObject({
      status: 'rejected',
      reason: 'host_binding_conflict',
      detail: `${SCOPE} is held by host incarnation incarnation-alpha (attempt IDENTITY_MINTED); an explicit matching expectedPredecessor is required`,
    })

    // Speaking the protocol transfers nothing. The occupant's binding, its
    // registration and its identities are exactly as they were.
    const after = readStore()
    expect(after.registrations).toEqual(before.registrations)
    expect(after.bindings).toEqual(before.bindings)
    expect(after.attempts).toEqual(before.attempts)
  })

  test('ACTIVE conflict names the exact predecessor state', async () => {
    await start()
    await join({})
    setAttemptState('ACTIVE', 'completed')

    const intruder = await observe(await join({ hostIncarnationId: 'incarnation-beta' }))
    expect(intruder.status).toBe(409)
    expect(intruder.body).toMatchObject({
      status: 'rejected',
      reason: 'host_binding_conflict',
      detail: `${SCOPE} is held by host incarnation incarnation-alpha (attempt ACTIVE); an explicit matching expectedPredecessor is required`,
    })
  })

  test('DETACHED conflict names reconnect state without inferring liveness', async () => {
    await start()
    await join({})
    setAttemptState('DETACHED', 'exhausted')

    const intruder = await observe(await join({ hostIncarnationId: 'incarnation-beta' }))
    expect(intruder.status).toBe(409)
    expect(intruder.body).toMatchObject({
      status: 'rejected',
      reason: 'host_binding_conflict',
      detail: `${SCOPE} is held by host incarnation incarnation-alpha (attempt DETACHED, reconnect exhausted; not evidence of host death or life); an explicit matching expectedPredecessor is required`,
    })
  })

  test('a second participant at a different address gets its own reservation', async () => {
    await start()
    await join({})
    const second = await observe(
      await join({ requestedSessionRef: OTHER_SCOPE, hostIncarnationId: 'incarnation-gamma' })
    )

    expect(second.body['status']).toBe('registered')
    const stored = readStore()
    expect(stored.reservations).toHaveLength(2)
    expect(stored.bindings).toHaveLength(2)
    expect(new Set(stored.registrations.map((row) => row['scope_ref']))).toEqual(
      new Set([SCOPE, OTHER_SCOPE])
    )
  })

  test('one incarnation cannot hold a second address', async () => {
    await start()
    await join({})
    const before = readStore()

    // The unique index already refuses this, but a raw constraint violation
    // reaching the wire as a 500 tells a real host nothing -- and a real host
    // reaches this simply by asking for another address.
    const second = await observe(await join({ requestedSessionRef: OTHER_SCOPE }))
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({
      status: 'rejected',
      reason: 'participant_host_incarnation_bound_elsewhere',
    })
    expect(second.body['detail']).toContain(SCOPE)

    const after = readStore()
    expect(after.registrations).toEqual(before.registrations)
    expect(after.bindings).toEqual(before.bindings)
    expect(after.reservations).toEqual(before.reservations)
  })

  test('redirects to the address home and commits nothing locally', async () => {
    await start()
    const now = new Date().toISOString()
    // An address this node holds for another home is the observable half of
    // R7.4: the request is answered with where to go, not forwarded there.
    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      db.sqlite
        .query(
          `INSERT INTO participant_address_reservations (
             reservation_id, class_id, scope_ref, lane_ref, home_node_id, state,
             created_at, updated_at)
           VALUES ('resv-elsewhere', NULL, ?, 'main', 'some-other-node', 'held', ?, ?)`
        )
        .run(OTHER_SCOPE, now, now)
    } finally {
      db.close()
    }

    const redirected = await observe(
      await join({ requestedSessionRef: OTHER_SCOPE, hostIncarnationId: 'incarnation-delta' })
    )

    expect(redirected.status).toBe(409)
    expect(redirected.body).toMatchObject({
      status: 'rejected',
      reason: 'participant_scope_bound_elsewhere',
      observed: { homeNodeId: 'some-other-node' },
    })

    // "No local registration/session/attempt is committed" is the part worth
    // asserting: a redirect that quietly minted a local row would still look
    // like a redirect from the outside.
    const stored = readStore()
    expect(stored.registrations).toHaveLength(0)
    expect(stored.attempts).toHaveLength(0)
    expect(stored.bindings).toHaveLength(0)
  })

  test('the redirected request succeeds at the home it named', async () => {
    // A 409 is half a route. R7.4 also requires the participant to retry THE
    // SAME address and incarnation at the home it was given, ending with
    // exactly one durable owner there -- so this drives both legs against two
    // separate servers with separate stores.
    //
    // Scope, stated rather than implied: the wrong node's reservation is SEEDED
    // directly into its store, and the retry target is chosen by this test. No
    // registry propagated the reservation and no discovery resolved the home.
    // What is real is the registration path, the placement logic and the
    // durable rows in two separate stores, so this is redirect-and-retry
    // evidence and NOT evidence of federation discovery or registry
    // propagation.
    await start()
    const now = new Date().toISOString()
    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      db.sqlite
        .query(
          `INSERT INTO participant_address_reservations (
             reservation_id, class_id, scope_ref, lane_ref, home_node_id, state,
             created_at, updated_at)
           VALUES ('resv-elsewhere', NULL, ?, 'main', 'some-other-node', 'held', ?, ?)`
        )
        .run(OTHER_SCOPE, now, now)
    } finally {
      db.close()
    }

    const redirected = await observe(
      await join({ requestedSessionRef: OTHER_SCOPE, hostIncarnationId: 'incarnation-router' })
    )
    expect(redirected.status).toBe(409)
    const homeNodeId = (redirected.body['observed'] as { homeNodeId: string }).homeNodeId
    expect(homeNodeId).toBe('some-other-node')
    expect(readStore().registrations).toHaveLength(0)

    // The home the participant was told to use. The request it sends there is
    // byte-identical to the one that was redirected.
    const home = await createHrcTestFixture('t08516-direct-join-home-')
    let homeServer: HrcServer | undefined
    try {
      homeServer = await createHrcServer(
        home.serverOpts({ otelListenerEnabled: false, registrationClasses: [] })
      )
      const request = {
        registrationMode: 'direct',
        requestedSessionRef: OTHER_SCOPE,
        hostIncarnationId: 'incarnation-router',
      }
      const accepted = await observe(await home.postJson('/v1/participants/register', request))
      expect(accepted.status).toBe(200)
      expect(accepted.body).toMatchObject({ status: 'registered', created: true })

      // A lost response converges at that home instead of minting a second owner.
      const retried = await observe(await home.postJson('/v1/participants/register', request))
      expect(retried.body['created']).toBe(false)
      // Both halves: comparing two ABSENT identities is vacuously equal, which
      // would let a pair of rejections satisfy this.
      expect(accepted.body['identity']).toBeDefined()
      expect(retried.body['identity']).toEqual(accepted.body['identity'])

      const homeDb = openHrcDatabase(home.dbPath, { migrate: false })
      try {
        expect(
          homeDb.sqlite
            .query<{ n: number }, [string]>(
              'SELECT COUNT(*) AS n FROM participant_registrations WHERE scope_ref = ?'
            )
            .get(OTHER_SCOPE)?.n
        ).toBe(1)
      } finally {
        homeDb.close()
      }
    } finally {
      await homeServer?.stop()
      await home.cleanup()
    }

    // And still nothing at the node that routed it.
    expect(readStore().registrations).toHaveLength(0)
  })

  test('separates an unparseable address from one policy refuses', async () => {
    await start()

    const malformed = await observe(await join({ requestedSessionRef: 'arris@hrc-runtime:T-1' }))
    expect(malformed.status).toBe(400)
    expect(malformed.body).toMatchObject({
      error: { code: 'malformed_request', detail: { field: 'requestedSessionRef' } },
    })

    const unknownField = await observe(await join({ provisioner: { name: 'belongs-to-epr' } }))
    expect(unknownField.status).toBe(400)
    expect(unknownField.body).toMatchObject({
      error: { code: 'malformed_request', detail: { field: 'provisioner' } },
    })

    for (const expectedPredecessor of [
      { hostIncarnationId: 'host-a', runtimeId: 'rt-a' },
      { hostIncarnationId: 'host-a', runtimeId: 'rt-a', generation: 1, extra: true },
    ]) {
      const invalidPredecessor = await observe(await join({ expectedPredecessor }))
      expect(invalidPredecessor.status).toBe(400)
      expect(invalidPredecessor.body).toMatchObject({
        error: { code: 'malformed_request', detail: { field: 'expectedPredecessor' } },
      })
    }
  })

  test('a reserved address is never given a substitute birth', async () => {
    await start()
    await join({})

    // R-4.3.1/R-4.3.2: the scope is not free, and an ordinary session birth at
    // it is refused rather than served by a newly minted generic runtime.
    const ensured = await observe(
      await fixture.postJson('/v1/sessions/ensure', { sessionRef: `${SCOPE}#main` })
    )
    expect(ensured.status).toBeGreaterThanOrEqual(400)
    const stored = readStore()
    expect(stored.runtimes).toHaveLength(0)
  })

  test('an unattached participant holds addressed work instead of birthing', async () => {
    await start()
    await join({})

    // The session-birth doors above are not the only way a runtime appears at
    // an address. `startRuntimeForSession` refuses a participant cold start,
    // but the broker routes provision their own runtimes and never pass
    // through it -- so a live enqueue against a real Arris participant walked
    // past that guard and BORN a second, HRC-owned tmux runtime at an address
    // an external host already held. A fixture could not see it: it took a
    // real host on the other end and an intent coherent enough to survive the
    // ASP compiler, because an incoherent one dies earlier and looks like a
    // refusal.
    const submitted = await observe(
      await fixture.postJson('/v1/submissions/enqueue', {
        target: `${SCOPE}/lane:main`,
        body: 'this must never reach a substitute runtime',
        origin: { principalRef: 'agent:clod' },
        runtimeIntent: {
          placement: {
            agentRoot: fixture.tmpDir,
            projectRoot: fixture.tmpDir,
            cwd: fixture.tmpDir,
            runMode: 'task',
            bundle: { kind: 'agent-project', agentName: 'arris', projectRoot: fixture.tmpDir },
          },
          harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
          execution: { preferredMode: 'headless' },
          provision: { harness: 'codex-cli', model: 'gpt-5.6-sol' },
        },
      })
    )

    // R7.6: a participant that has joined and not attached is PENDING, not
    // broken. The work stays eligible and drains once it attaches, and the
    // caller-supplied intent above does not override participant ownership.
    expect(submitted.status).toBe(503)
    expect(submitted.body).toMatchObject({
      error: {
        code: 'runtime_unavailable',
        detail: { reason: 'participant_attachment_pending', kind: 'pending' },
      },
    })
    // The refusal is only half the claim; nothing may have been born.
    expect(readStore().runtimes).toHaveLength(0)
  })

  test('a fresh-context request cannot rotate an external participant', async () => {
    await start()
    await join({})
    const before = readStore()

    // Rotating would move the address off the incarnation that holds it, which
    // is a replacement of someone else's process wearing a flag's clothing.
    const rotated = await observe(
      await fixture.postJson('/v1/submissions/enqueue', {
        target: `${SCOPE}/lane:main`,
        body: 'this must not rotate anyone',
        origin: { principalRef: 'agent:clod' },
        freshContext: true,
      })
    )
    expect(rotated.status).toBe(503)
    expect(rotated.body).toMatchObject({
      error: { detail: { reason: 'participant_rotation_unsupported' } },
    })

    const after = readStore()
    expect(after.registrations).toEqual(before.registrations)
    expect(after.bindings).toEqual(before.bindings)
    expect(after.runtimes).toHaveLength(0)
  })
})
