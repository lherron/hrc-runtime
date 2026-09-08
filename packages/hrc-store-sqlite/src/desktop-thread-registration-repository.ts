import type { Database } from 'bun:sqlite'

import { execute } from './migrations/types.js'

/**
 * Durable mapping from one Codex DESKTOP conversation to its permanent readable
 * Stella address (T-08294, campaign P-00502 leg B).
 *
 * Two properties make this table different from `roster_claims`, and both are
 * load-bearing rather than stylistic:
 *
 *  - **The key is native, not HRC-minted.** `(home_identity, native_thread_id)`
 *    is the registration key from the approved contract §4. Bundle version,
 *    conversation title, workspace cwd and observer identity all change under a
 *    live desktop thread; none of them may participate in identity. A thread
 *    that disappears and comes back must land on the same row, which is why the
 *    unique index is on the native pair and NOT on anything HRC allocated.
 *
 *  - **Rows are permanent.** There is deliberately no delete and no age-based
 *    prune here (contrast `RosterClaimRepository.deleteOlderThan`). A desktop
 *    scope reservation must survive idle, detach, archival, observer restart and
 *    daemon restart, because the reservation is what stops an ordinary exact or
 *    suffix-roster claim recycling `stella@hrc-ios:primary-nova` out from under
 *    a conversation Lance can still scroll back to. A pruned row is a recycled
 *    address, and a recycled address is mail delivered to a stranger.
 */
export type DesktopThreadRegistration = {
  /** `sha256(homeIdentity \0 nativeThreadId)` — the stable primary key. */
  registrationKey: string
  /** Canonical (realpath) Codex home identifying the local desktop install. */
  homeIdentity: string
  /** Effective canonical SQLite home; equals `homeIdentity` in the ordinary case. */
  sqliteHome: string
  /** Native desktop thread UUID. */
  nativeThreadId: string
  /** The permanent readable scope, e.g. `agent:stella:project:hrc-ios:task:primary-nova`. */
  scopeRef: string
  agentId: string
  /** Project FROZEN at registration. Later cwd/title changes never move it. */
  projectId: string
  /** Slot token inside the scope, e.g. `primary-nova` or `primary-nova-2`. */
  slotToken: string
  laneRef: string
  hostSessionId: string
  /** Resolved project root at registration, for diagnostics and driver cwd. */
  projectRoot: string
  /** The workspace the hook reported. Kept as evidence of what was resolved from. */
  workspaceCwd: string
  /** Native rollout JSONL path, when the hook knew one. */
  rolloutPath?: string | undefined
  /**
   * The UUID-style address this conversation used BEFORE registration, recorded
   * for the migration report only. Contract §4: historical addresses are never
   * silently forwarded, acked or reassigned.
   */
  legacyScopeRef?: string | undefined
  /** Compatibility metadata — explicitly NOT part of conversation identity. */
  bundlePath?: string | undefined
  bundleVersion?: string | undefined
  /** Hook source that produced the first successful registration. */
  registeredVia: string
  createdAt: string
  updatedAt: string
}

type DesktopThreadRegistrationRow = {
  registration_key: string
  home_identity: string
  sqlite_home: string
  native_thread_id: string
  scope_ref: string
  agent_id: string
  project_id: string
  slot_token: string
  lane_ref: string
  host_session_id: string
  project_root: string
  workspace_cwd: string
  rollout_path: string | null
  legacy_scope_ref: string | null
  bundle_path: string | null
  bundle_version: string | null
  registered_via: string
  created_at: string
  updated_at: string
}

const COLUMNS = `
  registration_key,
  home_identity,
  sqlite_home,
  native_thread_id,
  scope_ref,
  agent_id,
  project_id,
  slot_token,
  lane_ref,
  host_session_id,
  project_root,
  workspace_cwd,
  rollout_path,
  legacy_scope_ref,
  bundle_path,
  bundle_version,
  registered_via,
  created_at,
  updated_at`

function mapRow(row: DesktopThreadRegistrationRow): DesktopThreadRegistration {
  return {
    registrationKey: row.registration_key,
    homeIdentity: row.home_identity,
    sqliteHome: row.sqlite_home,
    nativeThreadId: row.native_thread_id,
    scopeRef: row.scope_ref,
    agentId: row.agent_id,
    projectId: row.project_id,
    slotToken: row.slot_token,
    laneRef: row.lane_ref,
    hostSessionId: row.host_session_id,
    projectRoot: row.project_root,
    workspaceCwd: row.workspace_cwd,
    ...(row.rollout_path === null ? {} : { rolloutPath: row.rollout_path }),
    ...(row.legacy_scope_ref === null ? {} : { legacyScopeRef: row.legacy_scope_ref }),
    ...(row.bundle_path === null ? {} : { bundlePath: row.bundle_path }),
    ...(row.bundle_version === null ? {} : { bundleVersion: row.bundle_version }),
    registeredVia: row.registered_via,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class DesktopThreadRegistrationRepository {
  constructor(private readonly db: Database) {}

  /**
   * Insert a registration. Callers MUST run this inside the same transaction as
   * the session it names AND under the shared scope-claim mutex — the mapping
   * and the scope reservation it asserts are one atomic fact, and the unique
   * index on `scope_ref` is the last-resort fence if that discipline slips.
   */
  insert(record: DesktopThreadRegistration): DesktopThreadRegistration {
    execute(
      this.db,
      `
        INSERT INTO desktop_thread_registrations (
          registration_key,
          home_identity,
          sqlite_home,
          native_thread_id,
          scope_ref,
          agent_id,
          project_id,
          slot_token,
          lane_ref,
          host_session_id,
          project_root,
          workspace_cwd,
          rollout_path,
          legacy_scope_ref,
          bundle_path,
          bundle_version,
          registered_via,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.registrationKey,
      record.homeIdentity,
      record.sqliteHome,
      record.nativeThreadId,
      record.scopeRef,
      record.agentId,
      record.projectId,
      record.slotToken,
      record.laneRef,
      record.hostSessionId,
      record.projectRoot,
      record.workspaceCwd,
      record.rolloutPath ?? null,
      record.legacyScopeRef ?? null,
      record.bundlePath ?? null,
      record.bundleVersion ?? null,
      record.registeredVia,
      record.createdAt,
      record.updatedAt
    )
    return record
  }

  /**
   * Refresh the mutable OBSERVATION facts of an existing mapping.
   *
   * The allow-list is the point: scope, project, slot, agent and the native key
   * are absent by construction, so no code path can rename a registered
   * conversation or move its project by "updating" it. Contract §4: subsequent
   * cwd/title changes do not rename the scope or move its project.
   */
  updateObservation(
    registrationKey: string,
    patch: {
      rolloutPath?: string | undefined
      workspaceCwd?: string | undefined
      bundlePath?: string | undefined
      bundleVersion?: string | undefined
      hostSessionId?: string | undefined
      updatedAt: string
    }
  ): void {
    const assignments: string[] = []
    const values: (string | null)[] = []
    for (const [column, value] of [
      ['rollout_path', patch.rolloutPath],
      ['workspace_cwd', patch.workspaceCwd],
      ['bundle_path', patch.bundlePath],
      ['bundle_version', patch.bundleVersion],
      ['host_session_id', patch.hostSessionId],
    ] as const) {
      if (value === undefined) continue
      assignments.push(`${column} = ?`)
      values.push(value)
    }
    assignments.push('updated_at = ?')
    values.push(patch.updatedAt)
    execute(
      this.db,
      `UPDATE desktop_thread_registrations SET ${assignments.join(', ')} WHERE registration_key = ?`,
      ...values,
      registrationKey
    )
  }

  getByRegistrationKey(registrationKey: string): DesktopThreadRegistration | null {
    const row = this.db
      .query<DesktopThreadRegistrationRow, [string]>(
        `SELECT ${COLUMNS} FROM desktop_thread_registrations WHERE registration_key = ?`
      )
      .get(registrationKey)
    return row ? mapRow(row) : null
  }

  getByNativeKey(homeIdentity: string, nativeThreadId: string): DesktopThreadRegistration | null {
    const row = this.db
      .query<DesktopThreadRegistrationRow, [string, string]>(
        `SELECT ${COLUMNS} FROM desktop_thread_registrations
           WHERE home_identity = ? AND native_thread_id = ?`
      )
      .get(homeIdentity, nativeThreadId)
    return row ? mapRow(row) : null
  }

  /**
   * The reservation predicate every ordinary allocator consults. A hit means the
   * scope belongs permanently to a desktop conversation and may not be minted,
   * recycled or rotated by exact/suffix claim.
   */
  getByScopeRef(scopeRef: string): DesktopThreadRegistration | null {
    const row = this.db
      .query<DesktopThreadRegistrationRow, [string]>(
        `SELECT ${COLUMNS} FROM desktop_thread_registrations WHERE scope_ref = ?`
      )
      .get(scopeRef)
    return row ? mapRow(row) : null
  }

  /** Every slot token already reserved in one agent+project namespace. */
  listSlotTokens(agentId: string, projectId: string): string[] {
    return this.db
      .query<{ slot_token: string }, [string, string]>(
        `SELECT slot_token FROM desktop_thread_registrations
           WHERE agent_id = ? AND project_id = ? ORDER BY created_at ASC`
      )
      .all(agentId, projectId)
      .map((row) => row.slot_token)
  }

  listAll(): DesktopThreadRegistration[] {
    return this.db
      .query<DesktopThreadRegistrationRow, []>(
        `SELECT ${COLUMNS} FROM desktop_thread_registrations ORDER BY created_at ASC`
      )
      .all()
      .map(mapRow)
  }

  listByHomeIdentity(homeIdentity: string): DesktopThreadRegistration[] {
    return this.db
      .query<DesktopThreadRegistrationRow, [string]>(
        `SELECT ${COLUMNS} FROM desktop_thread_registrations
           WHERE home_identity = ? ORDER BY created_at ASC`
      )
      .all(homeIdentity)
      .map(mapRow)
  }
}
