/**
 * T-08516 (8504A) — migration 0069 over a populated store.
 *
 * R7.1 requires migrating legacy ACTIVE and UNATTACHED rows, not an empty
 * store, so every case here applies 0001..0068, writes real rows through the
 * old schema, and only then applies 0069. An empty-store migration proves the
 * DDL parses; it proves nothing about the copy, the surviving constraints or
 * the foreign keys, which is where a rebuild actually goes wrong.
 */

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { schemaMigrations } from '../migrations/schema-migrations.js'

const PRE_0069 = '0068_participant_successor_evidence'
const JOIN_MIGRATION = '0069_participant_protocol_join'

function openThrough(lastMigrationId: string): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  for (const migration of schemaMigrations) {
    migration.apply(db)
    if (migration.id === lastMigrationId) return db
  }
  throw new Error(`migration ${lastMigrationId} is not in the schema list`)
}

function applyJoinMigration(db: Database): void {
  const migration = schemaMigrations.find((candidate) => candidate.id === JOIN_MIGRATION)
  if (migration === undefined) throw new Error(`${JOIN_MIGRATION} is not registered`)
  migration.apply(db)
}

/** A legacy registration plus one attempt, written through the pre-0069 schema. */
function seedLegacy(
  db: Database,
  suffix: string,
  attemptPatch: { state: string; prepared: boolean; work: string; attemptCount: number }
): void {
  db.query(
    `INSERT INTO participant_registrations (
       registration_id, class_id, adapter_id, join_direction, participant_key,
       scope_ref, lane_ref, host_session_id, generation, workspace_cwd,
       serving_socket_path, preparation_json, continuity_evidence_json,
       created_at, updated_at)
     VALUES (?, 'legacy-class', 'legacy-adapter', 'participant-served', ?, ?, 'main', ?, 1,
             '/tmp/legacy-workspace', '/tmp/legacy.sock', '{"opaque":true}', ?, ?, ?)`
  ).run(
    `preg-${suffix}`,
    `key-${suffix}`,
    `agent:smokey:project:hrc-runtime:task:legacy-${suffix}`,
    `hsid-${suffix}`,
    suffix === 'active' ? '{"evidence":"accepted"}' : null,
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z'
  )
  db.query(
    `INSERT INTO participant_registration_attempts (
       attempt_id, registration_id, attach_epoch, request_id, operation_id,
       invocation_id, runtime_id, state, prepared_profile_json,
       adapter_dispatch_env_json, initial_activation_confirmed_at,
       activation_classification, recovery_disposition, establishment_work_state,
       establishment_attempt_count, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', 'unresolved', ?, ?, ?, ?)`
  ).run(
    `patt-${suffix}`,
    `preg-${suffix}`,
    `req-${suffix}`,
    `op-${suffix}`,
    `inv-${suffix}`,
    `rt-${suffix}`,
    attemptPatch.state,
    attemptPatch.prepared ? '{"profile":"frozen"}' : null,
    attemptPatch.prepared ? '{"env":{}}' : null,
    attemptPatch.state === 'ACTIVE' ? '2026-09-01T00:05:00.000Z' : null,
    attemptPatch.work,
    attemptPatch.attemptCount,
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z'
  )
}

function seedBothLegacyStates(db: Database): void {
  // ACTIVE: prepared, activated, establishment completed.
  seedLegacy(db, 'active', {
    state: 'ACTIVE',
    prepared: true,
    work: 'completed',
    attemptCount: 2,
  })
  // UNATTACHED: identity minted, no profile, establishment still pending.
  seedLegacy(db, 'pending', {
    state: 'IDENTITY_MINTED',
    prepared: false,
    work: 'pending',
    attemptCount: 0,
  })
}

describe('T-08516 migration 0069 over a populated legacy store', () => {
  test('carries legacy active and unattached rows across the rebuild unchanged', () => {
    const db = openThrough(PRE_0069)
    seedBothLegacyStates(db)
    applyJoinMigration(db)

    const registrations = db
      .query<
        {
          registration_id: string
          registration_mode: string
          class_id: string | null
          adapter_id: string | null
          participant_key: string | null
          workspace_cwd: string | null
          preparation_json: string | null
          continuity_evidence_json: string | null
          address_policy: string | null
          host_incarnation_id: string | null
        },
        []
      >('SELECT * FROM participant_registrations ORDER BY registration_id')
      .all()

    expect(registrations).toHaveLength(2)
    for (const row of registrations) {
      expect(row.registration_mode).toBe('legacy')
      // Existing values survive; the relaxation is for direct joins alone.
      expect(row.class_id).toBe('legacy-class')
      expect(row.adapter_id).toBe('legacy-adapter')
      expect(row.workspace_cwd).toBe('/tmp/legacy-workspace')
      expect(row.preparation_json).toBe('{"opaque":true}')
      // Nothing was invented for a row that never declared it.
      expect(row.address_policy).toBeNull()
      expect(row.host_incarnation_id).toBeNull()
    }
    expect(
      registrations.find((row) => row.registration_id === 'preg-active')?.participant_key
    ).toBe('key-active')

    const attempts = db
      .query<
        {
          attempt_id: string
          state: string
          prepared_profile_json: string | null
          adapter_dispatch_env_json: string | null
          establishment_work_state: string
          establishment_attempt_count: number
          initial_activation_confirmed_at: string | null
          activation_classification: string | null
          host_binding_id: string | null
          continuation_carried: number | null
        },
        []
      >('SELECT * FROM participant_registration_attempts ORDER BY attempt_id')
      .all()

    expect(attempts).toHaveLength(2)
    const active = attempts.find((row) => row.attempt_id === 'patt-active')
    expect(active).toMatchObject({
      state: 'ACTIVE',
      prepared_profile_json: '{"profile":"frozen"}',
      adapter_dispatch_env_json: '{"env":{}}',
      establishment_work_state: 'completed',
      establishment_attempt_count: 2,
      initial_activation_confirmed_at: '2026-09-01T00:05:00.000Z',
      activation_classification: 'attached',
      host_binding_id: null,
      continuation_carried: null,
    })
    const pending = attempts.find((row) => row.attempt_id === 'patt-pending')
    expect(pending).toMatchObject({
      state: 'IDENTITY_MINTED',
      prepared_profile_json: null,
      adapter_dispatch_env_json: null,
      establishment_work_state: 'pending',
      establishment_attempt_count: 0,
      initial_activation_confirmed_at: null,
    })

    // The rebuild must not have orphaned a single child row.
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })

  test('restores the constraints and triggers the rebuild dropped', () => {
    const db = openThrough(PRE_0069)
    seedBothLegacyStates(db)
    applyJoinMigration(db)

    // The paired-NULL profile/environment CHECK survived.
    expect(() =>
      db
        .query(
          `UPDATE participant_registration_attempts
              SET prepared_profile_json = '{"half":true}' WHERE attempt_id = 'patt-pending'`
        )
        .run()
    ).toThrow()

    // 0066's recovery-reason triggers came back with the table.
    expect(() =>
      db
        .query(
          `UPDATE participant_registration_attempts
              SET recovery_disposition = 'abandoned' WHERE attempt_id = 'patt-active'`
        )
        .run()
    ).toThrow(/requires a reason/)

    // invocation_id is still globally unique.
    expect(() =>
      db
        .query(
          `UPDATE participant_registration_attempts
              SET invocation_id = 'inv-active' WHERE attempt_id = 'patt-pending'`
        )
        .run()
    ).toThrow()

    // (registration_id, attach_epoch) is still unique.
    expect(() =>
      db
        .query(
          `UPDATE participant_registration_attempts
              SET registration_id = 'preg-active' WHERE attempt_id = 'patt-pending'`
        )
        .run()
    ).toThrow()

    // The foreign key to registrations points at the NEW table, not the one
    // renamed aside during the rebuild.
    expect(() =>
      db
        .query(
          `UPDATE participant_registration_attempts
              SET registration_id = 'preg-does-not-exist' WHERE attempt_id = 'patt-pending'`
        )
        .run()
    ).toThrow(/FOREIGN KEY/)

    // The table renamed aside during the rebuild is gone.
    const leftovers = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE name LIKE '%pre0069%' OR name LIKE '%v0069%'`
      )
      .all()
    expect(leftovers).toEqual([])
    db.close()
  })

  test('legacy (class_id, participant_key) stays unique while classless direct rows do not collide', () => {
    const db = openThrough(PRE_0069)
    seedBothLegacyStates(db)
    applyJoinMigration(db)

    expect(() =>
      db
        .query(
          `UPDATE participant_registrations
              SET participant_key = 'key-active' WHERE registration_id = 'preg-pending'`
        )
        .run()
    ).toThrow()

    // Two classless direct joins each hold (NULL, NULL) and must both persist.
    for (const suffix of ['one', 'two']) {
      db.query(
        `INSERT INTO participant_registrations (
           registration_id, registration_mode, join_direction, scope_ref, lane_ref,
           host_session_id, generation, address_policy, continuity_policy,
           lifecycle_owner, replay_semantics, host_incarnation_id, created_at, updated_at)
         VALUES (?, 'direct', 'participant-served', ?, 'main', ?, 1,
                 'selected-scope', 'host-incarnation', 'externally-owned',
                 'full-source-replay', ?, ?, ?)`
      ).run(
        `preg-direct-${suffix}`,
        `agent:arris:project:hrc-runtime:task:direct-${suffix}`,
        `hsid-direct-${suffix}`,
        `incarnation-${suffix}`,
        '2026-09-15T00:00:00.000Z',
        '2026-09-15T00:00:00.000Z'
      )
    }
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM participant_registrations WHERE registration_mode = 'direct'`
        )
        .get()?.count
    ).toBe(2)
    db.close()
  })

  test('a legacy row keeps the two columns its identity is made of', () => {
    const db = openThrough(PRE_0069)
    seedBothLegacyStates(db)
    applyJoinMigration(db)

    // class_id and participant_key ARE legacy identity: they are its uniqueness
    // and its lookup, so they stay mandatory for a legacy row.
    for (const column of ['class_id', 'participant_key']) {
      expect(() =>
        db
          .query(
            `UPDATE participant_registrations SET ${column} = NULL WHERE registration_id = 'preg-active'`
          )
          .run()
      ).toThrow()
    }

    // workspace_cwd and preparation_json are not. With adapter admission gone
    // nothing supplies them at registration, so a NEW legacy row may leave them
    // null -- while the rows migrated above still carry the values they had.
    db.query(
      `INSERT INTO participant_registrations (
         registration_id, registration_mode, class_id, adapter_id, join_direction,
         participant_key, scope_ref, lane_ref, host_session_id, generation,
         created_at, updated_at)
       VALUES ('preg-new-legacy', 'legacy', 'legacy-class', 'legacy-adapter',
               'participant-served', 'key-new', 'agent:smokey:project:hrc-runtime:task:new',
               'main', 'hsid-new', 1, ?, ?)`
    ).run('2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z')
    expect(
      db
        .query<
          { workspace_cwd: string | null; preparation_json: string | null },
          []
        >(`SELECT workspace_cwd, preparation_json FROM participant_registrations
             WHERE registration_id = 'preg-new-legacy'`)
        .get()
    ).toEqual({ workspace_cwd: null, preparation_json: null })
    expect(
      db
        .query<{ workspace_cwd: string | null }, []>(
          `SELECT workspace_cwd FROM participant_registrations WHERE registration_id = 'preg-active'`
        )
        .get()?.workspace_cwd
    ).toBe('/tmp/legacy-workspace')
    db.close()
  })

  test('narrows runtime ownership to one host binding without losing legacy exclusivity', () => {
    const db = openThrough(PRE_0069)
    seedBothLegacyStates(db)
    applyJoinMigration(db)

    // Legacy attempts carry no binding, so they keep exclusive runtime ownership.
    expect(() =>
      db
        .query(
          `UPDATE participant_registration_attempts
              SET runtime_id = 'rt-active' WHERE attempt_id = 'patt-pending'`
        )
        .run()
    ).toThrow(/owned by a different host binding/)

    const now = '2026-09-15T00:00:00.000Z'
    db.query(
      `INSERT INTO participant_address_reservations (
         reservation_id, class_id, scope_ref, lane_ref, home_node_id, state, created_at, updated_at)
       VALUES ('resv-1', NULL, 'agent:arris:project:hrc-runtime:task:direct', 'main', 'max3', 'held', ?, ?)`
    ).run(now, now)
    db.query(
      `INSERT INTO participant_registrations (
         registration_id, registration_mode, join_direction, scope_ref, lane_ref,
         host_session_id, generation, address_policy, continuity_policy,
         lifecycle_owner, replay_semantics, host_incarnation_id, created_at, updated_at)
       VALUES ('preg-direct', 'direct', 'participant-served',
               'agent:arris:project:hrc-runtime:task:direct', 'main', 'hsid-direct', 1,
               'selected-scope', 'host-incarnation', 'externally-owned',
               'full-source-replay', 'incarnation-a', ?, ?)`
    ).run(now, now)
    for (const [bindingId, incarnation] of [
      ['bind-a', 'incarnation-a'],
      ['bind-b', 'incarnation-b'],
    ]) {
      const retired = bindingId !== 'bind-a'
      db.query(
        `INSERT INTO participant_host_bindings (
           binding_id, reservation_id, registration_id, host_incarnation_id,
           host_session_id, generation, runtime_id, state, admitted_at, updated_at,
           retired_at, disposition_reason)
         VALUES (?, 'resv-1', 'preg-direct', ?, 'hsid-direct', 1, 'rt-shared',
                 ?, ?, ?, ?, ?)`
      ).run(
        bindingId,
        incarnation,
        retired ? 'RETIRED' : 'BOUND',
        now,
        now,
        retired ? now : null,
        retired ? 'seeded predecessor for the cross-binding runtime case' : null
      )
    }

    const insertAttempt = (attemptId: string, epoch: number, bindingId: string | null): void => {
      db.query(
        `INSERT INTO participant_registration_attempts (
           attempt_id, registration_id, attach_epoch, request_id, operation_id,
           invocation_id, runtime_id, host_binding_id, state, recovery_disposition,
           establishment_work_state, establishment_attempt_count, created_at, updated_at)
         VALUES (?, 'preg-direct', ?, ?, ?, ?, 'rt-shared', ?, 'IDENTITY_MINTED',
                 'unresolved', 'pending', 0, ?, ?)`
      ).run(
        attemptId,
        epoch,
        `req-${attemptId}`,
        `op-${attemptId}`,
        `inv-${attemptId}`,
        bindingId,
        now,
        now
      )
    }

    // H1 shares a runtime within ONE binding: two attempts, same binding.
    insertAttempt('patt-h1-a', 1, 'bind-a')
    insertAttempt('patt-h1-b', 2, 'bind-a')
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM participant_registration_attempts WHERE runtime_id = 'rt-shared'`
        )
        .get()?.count
    ).toBe(2)

    // A different binding may not claim that runtime. This is the case the
    // rejected unique(host_binding_id, attach_epoch) index would have allowed.
    expect(() => insertAttempt('patt-cross', 3, 'bind-b')).toThrow(
      /owned by a different host binding/
    )
    // Nor may an unbound attempt take a runtime a binding already owns.
    expect(() => insertAttempt('patt-unbound', 4, null)).toThrow(
      /owned by a different host binding/
    )
    db.close()
  })

  test('the address reservation and host binding uniqueness directions are both enforced', () => {
    const db = openThrough(PRE_0069)
    applyJoinMigration(db)
    const now = '2026-09-15T00:00:00.000Z'

    const insertReservation = (id: string, scope: string): void => {
      db.query(
        `INSERT INTO participant_address_reservations (
           reservation_id, class_id, scope_ref, lane_ref, home_node_id, state, created_at, updated_at)
         VALUES (?, NULL, ?, 'main', 'max3', 'held', ?, ?)`
      ).run(id, scope, now, now)
    }
    insertReservation('resv-1', 'agent:arris:project:hrc-runtime:task:one')
    expect(() =>
      insertReservation('resv-dup', 'agent:arris:project:hrc-runtime:task:one')
    ).toThrow()
    insertReservation('resv-2', 'agent:arris:project:hrc-runtime:task:two')

    // A release needs an actor and a reason or it is not a release.
    expect(() =>
      db
        .query(
          `UPDATE participant_address_reservations SET state = 'released' WHERE reservation_id = 'resv-2'`
        )
        .run()
    ).toThrow(/requires actor and reason/)

    for (const [suffix, reservation] of [
      ['one', 'resv-1'],
      ['two', 'resv-2'],
    ]) {
      db.query(
        `INSERT INTO participant_registrations (
           registration_id, registration_mode, join_direction, scope_ref, lane_ref,
           host_session_id, generation, address_policy, continuity_policy,
           lifecycle_owner, replay_semantics, host_incarnation_id, created_at, updated_at)
         VALUES (?, 'direct', 'participant-served', ?, 'main', ?, 1,
                 'selected-scope', 'host-incarnation', 'externally-owned',
                 'full-source-replay', ?, ?, ?)`
      ).run(
        `preg-${suffix}`,
        `agent:arris:project:hrc-runtime:task:${suffix}`,
        `hsid-${suffix}`,
        `incarnation-${suffix}`,
        now,
        now
      )
      db.query(
        `INSERT INTO participant_host_bindings (
           binding_id, reservation_id, registration_id, host_incarnation_id,
           host_session_id, generation, runtime_id, state, admitted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 'BOUND', ?, ?)`
      ).run(
        `bind-${suffix}`,
        reservation,
        `preg-${suffix}`,
        `incarnation-${suffix}`,
        `hsid-${suffix}`,
        `rt-${suffix}`,
        now,
        now
      )
    }

    // One address holds at most one LIVE host.
    expect(() =>
      db
        .query(
          `INSERT INTO participant_host_bindings (
             binding_id, reservation_id, registration_id, host_incarnation_id,
             host_session_id, generation, runtime_id, state, admitted_at, updated_at)
           VALUES ('bind-intruder', 'resv-1', 'preg-one', 'incarnation-intruder',
                   'hsid-one', 2, 'rt-intruder', 'BINDING', ?, ?)`
        )
        .run(now, now)
    ).toThrow()

    // One host incarnation holds at most one address.
    expect(() =>
      db
        .query(
          `UPDATE participant_host_bindings
              SET host_incarnation_id = 'incarnation-one' WHERE binding_id = 'bind-two'`
        )
        .run()
    ).toThrow()
    db.close()
  })

  test('a carried continuation must name what it carried and a refused one must not', () => {
    const db = openThrough(PRE_0069)
    seedBothLegacyStates(db)
    applyJoinMigration(db)

    const setContinuation = (
      carried: number | null,
      reason: string | null,
      selected: string | null
    ): void => {
      db.query(
        `UPDATE participant_registration_attempts
            SET continuation_carried = ?, continuation_reason = ?, continuation_selected_json = ?
          WHERE attempt_id = 'patt-pending'`
      ).run(carried, reason, selected)
    }

    setContinuation(1, 'carried', '{"continuationId":"c-1"}')
    setContinuation(0, 'no_continuation', null)
    // carried:true with nothing carried is the exact shape of a fabricated resume.
    expect(() => setContinuation(1, 'carried', null)).toThrow()
    // carried:false while still naming a selection is the same lie inverted.
    expect(() => setContinuation(0, 'no_continuation', '{"continuationId":"c-1"}')).toThrow()
    expect(() => setContinuation(0, 'carried', null)).toThrow()
    db.close()
  })
})
