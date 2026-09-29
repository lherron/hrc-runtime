import type { Database } from 'bun:sqlite'
import type { HrcPermissionDecisionRecord, HrcRuntimeArtifactRecord } from 'hrc-core'
import {
  PERMISSION_DECISION_COLUMNS,
  type PermissionDecisionRow,
  RUNTIME_ARTIFACT_COLUMNS,
  type RuntimeArtifactRow,
  mapPermissionDecisionRow,
  mapRuntimeArtifactRow,
} from './broker.js'
import { execute, requireRecord } from './shared.js'

export class RuntimeArtifactRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcRuntimeArtifactRecord): HrcRuntimeArtifactRecord {
    execute(
      this.db,
      `
        INSERT INTO runtime_artifacts (
          artifact_id,
          operation_id,
          artifact_kind,
          media_type,
          storage_kind,
          content_hash,
          artifact_json,
          artifact_path,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.artifactId,
      record.operationId,
      record.artifactKind,
      record.mediaType,
      record.storageKind,
      record.contentHash,
      record.artifactJson ?? null,
      record.artifactPath ?? null,
      record.createdAt
    )

    return requireRecord(
      this.getByArtifactId(record.artifactId),
      `failed to reload runtime artifact ${record.artifactId}`
    )
  }

  insertIdempotent(record: HrcRuntimeArtifactRecord): HrcRuntimeArtifactRecord {
    const existing = this.getByArtifactId(record.artifactId)
    if (existing) {
      if (!sameRuntimeArtifact(existing, record)) {
        throw new Error(
          `runtime_artifacts conflict: artifact_id=${record.artifactId} already exists with different content`
        )
      }
      return existing
    }
    return this.insert(record)
  }

  getByArtifactId(artifactId: string): HrcRuntimeArtifactRecord | null {
    const row = this.db
      .query<RuntimeArtifactRow, [string]>(
        `SELECT ${RUNTIME_ARTIFACT_COLUMNS} FROM runtime_artifacts WHERE artifact_id = ?`
      )
      .get(artifactId)

    return row ? mapRuntimeArtifactRow(row) : null
  }

  listByOperationId(operationId: string): HrcRuntimeArtifactRecord[] {
    const rows = this.db
      .query<RuntimeArtifactRow, [string]>(
        `SELECT ${RUNTIME_ARTIFACT_COLUMNS} FROM runtime_artifacts
          WHERE operation_id = ?
          ORDER BY created_at ASC, artifact_id ASC`
      )
      .all(operationId)

    return rows.map(mapRuntimeArtifactRow)
  }

  listByOperationIdAndKind(operationId: string, artifactKind: string): HrcRuntimeArtifactRecord[] {
    const rows = this.db
      .query<RuntimeArtifactRow, [string, string]>(
        `SELECT ${RUNTIME_ARTIFACT_COLUMNS} FROM runtime_artifacts
          WHERE operation_id = ? AND artifact_kind = ?
          ORDER BY created_at ASC, artifact_id ASC`
      )
      .all(operationId, artifactKind)

    return rows.map(mapRuntimeArtifactRow)
  }

  getLatestByOperationIdAndKind(
    operationId: string,
    artifactKind: string
  ): HrcRuntimeArtifactRecord | null {
    const row = this.db
      .query<RuntimeArtifactRow, [string, string]>(
        `SELECT ${RUNTIME_ARTIFACT_COLUMNS} FROM runtime_artifacts
          WHERE operation_id = ? AND artifact_kind = ?
          ORDER BY created_at DESC, artifact_id DESC
          LIMIT 1`
      )
      .get(operationId, artifactKind)

    return row ? mapRuntimeArtifactRow(row) : null
  }

  listByKind(artifactKind: string): HrcRuntimeArtifactRecord[] {
    const rows = this.db
      .query<RuntimeArtifactRow, [string]>(
        `SELECT ${RUNTIME_ARTIFACT_COLUMNS} FROM runtime_artifacts
          WHERE artifact_kind = ?
          ORDER BY created_at ASC, artifact_id ASC`
      )
      .all(artifactKind)

    return rows.map(mapRuntimeArtifactRow)
  }

  /**
   * T-07235 — the repository's only deletion path. Artifact classes with a
   * declared retention policy (see docs/state-retention.md) prune their own
   * rows through this; nothing here deletes by age or by sweep on its own.
   * Returns true when a row was removed.
   */
  deleteByArtifactId(artifactId: string): boolean {
    const result = this.db
      .query('DELETE FROM runtime_artifacts WHERE artifact_id = ?')
      .run(artifactId) as { changes?: number }
    return (result.changes ?? 0) > 0
  }
}

function sameRuntimeArtifact(
  existing: HrcRuntimeArtifactRecord,
  next: HrcRuntimeArtifactRecord
): boolean {
  return (
    existing.operationId === next.operationId &&
    existing.artifactKind === next.artifactKind &&
    existing.mediaType === next.mediaType &&
    existing.storageKind === next.storageKind &&
    existing.contentHash === next.contentHash &&
    (existing.artifactJson ?? null) === (next.artifactJson ?? null) &&
    (existing.artifactPath ?? null) === (next.artifactPath ?? null) &&
    existing.createdAt === next.createdAt
  )
}

export function computePermissionIdentityKey(input: {
  invocationId: string
  harnessGeneration?: number | null | undefined
  turnAttempt?: number | null | undefined
  permissionRequestId: string
}): string {
  return JSON.stringify([
    input.invocationId,
    input.harnessGeneration ?? null,
    input.turnAttempt ?? null,
    input.permissionRequestId,
  ])
}

export class PermissionDecisionRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcPermissionDecisionRecord): HrcPermissionDecisionRecord {
    const permissionIdentityKey =
      record.permissionIdentityKey ??
      computePermissionIdentityKey({
        invocationId: record.invocationId,
        harnessGeneration: record.harnessGeneration,
        turnAttempt: record.turnAttempt,
        permissionRequestId: record.permissionRequestId,
      })

    execute(
      this.db,
      `
        INSERT INTO permission_decisions (
          permission_identity_key,
          permission_request_id,
          invocation_id,
          harness_generation,
          turn_attempt,
          runtime_id,
          run_id,
          kind,
          subject_display_json,
          default_decision,
          decision,
          decided_by,
          policy_json,
          requested_at,
          decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      permissionIdentityKey,
      record.permissionRequestId,
      record.invocationId,
      record.harnessGeneration ?? null,
      record.turnAttempt ?? null,
      record.runtimeId,
      record.runId ?? null,
      record.kind,
      record.subjectDisplayJson,
      record.defaultDecision,
      record.decision,
      record.decidedBy,
      record.policyJson,
      record.requestedAt,
      record.decidedAt
    )

    return requireRecord(
      this.getByPermissionIdentityKey(permissionIdentityKey),
      `failed to reload permission decision ${permissionIdentityKey}`
    )
  }

  getByPermissionIdentityKey(permissionIdentityKey: string): HrcPermissionDecisionRecord | null {
    const row = this.db
      .query<PermissionDecisionRow, [string]>(
        `SELECT ${PERMISSION_DECISION_COLUMNS} FROM permission_decisions
          WHERE permission_identity_key = ?`
      )
      .get(permissionIdentityKey)

    return row ? mapPermissionDecisionRow(row) : null
  }

  getByPermissionRequestId(permissionRequestId: string): HrcPermissionDecisionRecord | null {
    const row = this.db
      .query<PermissionDecisionRow, [string]>(
        `SELECT ${PERMISSION_DECISION_COLUMNS} FROM permission_decisions
          WHERE permission_request_id = ?
          ORDER BY requested_at ASC, permission_identity_key ASC
          LIMIT 1`
      )
      .get(permissionRequestId)

    return row ? mapPermissionDecisionRow(row) : null
  }

  listByInvocationId(invocationId: string): HrcPermissionDecisionRecord[] {
    const rows = this.db
      .query<PermissionDecisionRow, [string]>(
        `SELECT ${PERMISSION_DECISION_COLUMNS} FROM permission_decisions
          WHERE invocation_id = ?
          ORDER BY requested_at ASC, permission_identity_key ASC`
      )
      .all(invocationId)

    return rows.map(mapPermissionDecisionRow)
  }
}
