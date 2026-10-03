import { deriveSessionIdentity } from '../session-identity.js'
import type { HrcMigration } from './types.js'

export const sessionIdentityMetadata: HrcMigration = {
  id: '0122_session_identity_metadata',
  apply(db) {
    const view = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE name='session_index_projection_source'"
      )
      .get()!.sql
    const triggers = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'session_index_%'"
      )
      .all()
    for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`)
    db.exec('DROP VIEW session_index_projection_source')
    db.exec("ALTER TABLE continuities ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'unparsed'")
    db.exec("ALTER TABLE continuities ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''")
    for (const col of ['project_id', 'task_id', 'role_name'])
      db.exec(`ALTER TABLE continuities ADD COLUMN ${col} TEXT`)
    let unparsed = 0
    const rows = db
      .query<{ scope_ref: string; lane_ref: string }, []>(
        'SELECT scope_ref,lane_ref FROM continuities'
      )
      .all()
    const update = db.query(
      'UPDATE continuities SET scope_kind=?,agent_id=?,project_id=?,task_id=?,role_name=? WHERE scope_ref=? AND lane_ref=?'
    )
    for (const row of rows) {
      const i = deriveSessionIdentity(row.scope_ref)
      if (i.kind === 'unparsed') unparsed++
      update.run(
        i.kind,
        i.agentId,
        i.projectId ?? null,
        i.taskId ?? null,
        i.roleName ?? null,
        row.scope_ref,
        row.lane_ref
      )
    }
    process.stderr.write(
      `hrc-store: session.identity.backfill total=${rows.length} unparsed=${unparsed}\n`
    )
    db.exec(
      `CREATE TABLE session_metadata(scope_ref TEXT NOT NULL,lane_ref TEXT NOT NULL,key TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('launch','hrc','api')),value_json TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,PRIMARY KEY(scope_ref,lane_ref,key,source))`
    )
    // Old titles resolve through sessions; newest timestamp wins per continuity.
    db.exec(
      `INSERT INTO session_metadata SELECT s.scope_ref,s.lane_ref,'title','api',json_quote(t.title),t.updated_at,'migration' FROM session_titles t JOIN sessions s USING(host_session_id) JOIN continuities c ON c.scope_ref=s.scope_ref AND c.lane_ref=s.lane_ref WHERE t.host_session_id=(SELECT t2.host_session_id FROM session_titles t2 JOIN sessions s2 USING(host_session_id) WHERE s2.scope_ref=s.scope_ref AND s2.lane_ref=s.lane_ref ORDER BY t2.updated_at DESC,t2.host_session_id DESC LIMIT 1)`
    )
    db.exec('DROP TABLE session_titles')
    db.exec('ALTER TABLE session_index ADD COLUMN task_id TEXT')
    const start = view.indexOf('        CASE')
    const end = view.indexOf('        s.created_at,', start)
    if (start < 0 || end < 0) throw new Error('session index identity projection shape changed')
    const projected = `${view.slice(0, start)}        c.agent_id, c.project_id, c.task_id,\n${view.slice(end)}`
    const newView = projected
      .replace(
        /t\.title(?: AS title)?/,
        () =>
          "(SELECT json_extract(m.value_json,'$') FROM session_metadata m WHERE m.scope_ref=s.scope_ref AND m.lane_ref=s.lane_ref AND m.key='title' ORDER BY CASE m.source WHEN 'api' THEN 3 WHEN 'launch' THEN 2 ELSE 1 END DESC LIMIT 1) AS title"
      )
      .replace(/\s+LEFT JOIN session_titles t ON t.host_session_id = s.host_session_id\s*$/, '')
    db.exec(newView)
    for (const t of triggers) {
      if (t.name.startsWith('session_index_title_')) continue
      let sql = t.sql
      if (t.name.startsWith('session_index_continuity_'))
        sql = sql
          .replaceAll('agent_id, project_id,', 'agent_id, project_id, task_id,')
          .replace(
            'project_id = excluded.project_id,',
            'project_id = excluded.project_id, task_id = excluded.task_id,'
          )
      db.exec(sql)
    }
    for (const [op, ref] of [
      ['INSERT', 'NEW'],
      ['UPDATE', 'NEW'],
      ['DELETE', 'OLD'],
    ] as const)
      db.exec(
        `CREATE TRIGGER session_index_metadata_${op.toLowerCase()} AFTER ${op} ON session_metadata WHEN ${ref}.key='title' BEGIN UPDATE session_index SET title=(SELECT json_extract(value_json,'$') FROM session_metadata WHERE scope_ref=${ref}.scope_ref AND lane_ref=${ref}.lane_ref AND key='title' ORDER BY CASE source WHEN 'api' THEN 3 WHEN 'launch' THEN 2 ELSE 1 END DESC LIMIT 1) WHERE scope_ref=${ref}.scope_ref AND lane_ref=${ref}.lane_ref; END`
      )
    db.exec(
      'UPDATE session_index SET agent_id=(SELECT agent_id FROM continuities c WHERE c.scope_ref=session_index.scope_ref AND c.lane_ref=session_index.lane_ref),project_id=(SELECT project_id FROM continuities c WHERE c.scope_ref=session_index.scope_ref AND c.lane_ref=session_index.lane_ref),task_id=(SELECT task_id FROM continuities c WHERE c.scope_ref=session_index.scope_ref AND c.lane_ref=session_index.lane_ref),title=(SELECT title FROM session_index_projection_source p WHERE p.scope_ref=session_index.scope_ref AND p.lane_ref=session_index.lane_ref)'
    )
  },
}
