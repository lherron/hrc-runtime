import type { Database } from 'bun:sqlite'
import { normalizeLaneRef, parseScopeRef } from 'agent-scope'
import type { SessionIdentity } from 'hrc-core'

/** Shared by continuity insertion and the TypeScript backfill. */
export function deriveSessionIdentity(scopeRef: string): SessionIdentity {
  try {
    const parsed = parseScopeRef(scopeRef)
    return {
      kind: parsed.kind,
      agentId: parsed.agentId,
      ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
      ...(parsed.taskId === undefined ? {} : { taskId: parsed.taskId }),
      ...(parsed.roleName === undefined ? {} : { roleName: parsed.roleName }),
    }
  } catch {
    return { kind: 'unparsed', agentId: scopeRef }
  }
}
export function canonicalLaneRef(laneRef: string): string {
  return normalizeLaneRef(
    laneRef === 'main' || laneRef.startsWith('lane:') ? laneRef : `lane:${laneRef}`
  )
}
export function readSessionIdentity(
  db: Database,
  scopeRef: string,
  laneRef: string
): SessionIdentity | undefined {
  const row = db
    .query<
      {
        scope_kind: SessionIdentity['kind']
        agent_id: string
        project_id: string | null
        task_id: string | null
        role_name: string | null
      },
      [string, string]
    >(
      'SELECT scope_kind, agent_id, project_id, task_id, role_name FROM continuities WHERE scope_ref=? AND lane_ref=?'
    )
    .get(scopeRef, laneRef)
  if (!row) return undefined
  return {
    kind: row.scope_kind,
    agentId: row.agent_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.role_name === null ? {} : { roleName: row.role_name }),
  }
}
