import type { HrcMigration } from './types.js'

/**
 * T-07500 — durable per-conversation titles and their session-index projection.
 *
 * Titles are keyed by host_session_id so rotating a continuity starts with no
 * title. They are display-only: this migration does not alter recency or any
 * session-index filter/cursor columns.
 */
const sessionTitlesMigration: HrcMigration = {
  id: '0045_session_titles',
  apply(db) {
    db.exec(`
      CREATE TABLE session_titles (
        host_session_id TEXT PRIMARY KEY REFERENCES sessions(host_session_id),
        title           TEXT NOT NULL,
        source          TEXT NOT NULL CHECK (source IN ('generated','manual')),
        model           TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      ALTER TABLE session_index ADD COLUMN title TEXT;

      DROP VIEW session_index_projection_source;
      CREATE VIEW session_index_projection_source AS
      SELECT
        s.scope_ref,
        s.lane_ref,
        s.host_session_id,
        s.generation,
        CASE
          WHEN substr(s.scope_ref, 1, 6) = 'agent:' THEN
            CASE
              WHEN instr(substr(s.scope_ref, 7), ':') = 0
                   AND instr(substr(s.scope_ref, 7), '/') = 0
                THEN substr(s.scope_ref, 7)
              WHEN instr(substr(s.scope_ref, 7), ':') = 0
                THEN substr(s.scope_ref, 7, instr(substr(s.scope_ref, 7), '/') - 1)
              WHEN instr(substr(s.scope_ref, 7), '/') = 0
                THEN substr(s.scope_ref, 7, instr(substr(s.scope_ref, 7), ':') - 1)
              ELSE substr(
                s.scope_ref,
                7,
                min(instr(substr(s.scope_ref, 7), ':'), instr(substr(s.scope_ref, 7), '/')) - 1
              )
            END
          ELSE s.scope_ref
        END AS agent_id,
        CASE
          WHEN instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') = 0 THEN NULL
          ELSE
            CASE
              WHEN instr(
                substr(
                  replace(s.scope_ref, '/project:', ':project:'),
                  instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                ),
                ':'
              ) = 0
                THEN substr(
                  replace(s.scope_ref, '/project:', ':project:'),
                  instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                )
              ELSE substr(
                substr(
                  replace(s.scope_ref, '/project:', ':project:'),
                  instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                ),
                1,
                instr(
                  substr(
                    replace(s.scope_ref, '/project:', ':project:'),
                    instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                  ),
                  ':'
                ) - 1
              )
            END
        END AS project_id,
        s.created_at,
        CASE
          WHEN lower(s.status) LIKE '%stale%' THEN 'stale'
          WHEN lower(s.status) LIKE '%inactive%'
            OR lower(s.status) LIKE '%archived%'
            OR lower(s.status) LIKE '%closed%'
            OR lower(s.status) LIKE '%terminated%' THEN 'inactive'
          WHEN lower(r.status) = 'detached' THEN 'detached'
          WHEN lower(r.status) LIKE '%stale%' THEN 'stale'
          WHEN r.runtime_id IS NULL
            OR lower(r.status) IN ('dead', 'stopped', 'crashed', 'exited', 'terminated')
            THEN 'inactive'
          ELSE 'active'
        END AS effective_status,
        CASE
          WHEN json_extract(s.last_applied_intent_json, '$.execution.preferredMode')
            IN ('headless', 'interactive', 'nonInteractive')
            THEN json_extract(s.last_applied_intent_json, '$.execution.preferredMode')
          WHEN r.transport = 'headless' THEN 'headless'
          WHEN r.supports_inflight_input = 1 THEN 'interactive'
          ELSE 'nonInteractive'
        END AS execution_mode,
        COALESCE(
          (
            SELECT MAX(e.ts)
            FROM hrc_events e
            WHERE e.host_session_id = s.host_session_id
              AND e.generation = s.generation
          ),
          r.last_activity_at,
          s.updated_at
        ) AS backfill_last_activity_at,
        t.title
      FROM sessions s
      INNER JOIN continuities c
        ON c.scope_ref = s.scope_ref
       AND c.lane_ref = s.lane_ref
       AND c.active_host_session_id = s.host_session_id
      LEFT JOIN runtimes r
        ON r.runtime_id = (
          SELECT lr.runtime_id
          FROM runtimes lr
          WHERE lr.host_session_id = s.host_session_id
            AND lr.generation = s.generation
          ORDER BY lr.updated_at DESC, lr.runtime_id DESC
          LIMIT 1
        )
      LEFT JOIN session_titles t ON t.host_session_id = s.host_session_id;

      DROP TRIGGER session_index_continuity_insert;
      CREATE TRIGGER session_index_continuity_insert
      AFTER INSERT ON continuities
      BEGIN
        INSERT INTO session_index (
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, last_activity_at, title
        )
        SELECT
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, backfill_last_activity_at, title
        FROM session_index_projection_source
        WHERE scope_ref = NEW.scope_ref AND lane_ref = NEW.lane_ref
        ON CONFLICT(scope_ref, lane_ref) DO UPDATE SET
          host_session_id = excluded.host_session_id,
          generation = excluded.generation,
          agent_id = excluded.agent_id,
          project_id = excluded.project_id,
          created_at = excluded.created_at,
          effective_status = excluded.effective_status,
          execution_mode = excluded.execution_mode,
          last_activity_at = excluded.last_activity_at,
          title = excluded.title;
      END;

      DROP TRIGGER session_index_continuity_update;
      CREATE TRIGGER session_index_continuity_update
      AFTER UPDATE OF active_host_session_id ON continuities
      BEGIN
        INSERT INTO session_index (
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, last_activity_at, title
        )
        SELECT
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, backfill_last_activity_at, title
        FROM session_index_projection_source
        WHERE scope_ref = NEW.scope_ref AND lane_ref = NEW.lane_ref
        ON CONFLICT(scope_ref, lane_ref) DO UPDATE SET
          host_session_id = excluded.host_session_id,
          generation = excluded.generation,
          agent_id = excluded.agent_id,
          project_id = excluded.project_id,
          created_at = excluded.created_at,
          effective_status = excluded.effective_status,
          execution_mode = excluded.execution_mode,
          last_activity_at = excluded.last_activity_at,
          title = excluded.title;
      END;

      CREATE TRIGGER session_index_title_insert
      AFTER INSERT ON session_titles
      BEGIN
        UPDATE session_index
        SET title = NEW.title
        WHERE host_session_id = NEW.host_session_id;
      END;

      CREATE TRIGGER session_index_title_update
      AFTER UPDATE ON session_titles
      BEGIN
        UPDATE session_index
        SET title = NEW.title
        WHERE host_session_id = NEW.host_session_id;
      END;

      CREATE TRIGGER session_index_title_delete
      AFTER DELETE ON session_titles
      BEGIN
        UPDATE session_index
        SET title = NULL
        WHERE host_session_id = OLD.host_session_id;
      END;
    `)
  },
}

export const sessionTitleMigrations: readonly HrcMigration[] = [sessionTitlesMigration]
