import type { HrcMigration } from './types.js'

/**
 * T-07512 — cascade session titles when their session is deleted.
 *
 * 0045 declared `host_session_id ... REFERENCES sessions(host_session_id)` with
 * no ON DELETE clause, and the store opens with `PRAGMA foreign_keys = ON`. No
 * `DELETE FROM sessions` path exists yet, so nothing can trip it today — but the
 * retention/vacuum work (T-07024) adds one, and the first titled session it
 * reached would fail with a foreign key violation.
 *
 * SQLite cannot alter a foreign key in place, so the table is rebuilt. Two
 * things about that are load-bearing:
 *
 *   - `DROP TABLE session_titles` also drops the three `session_index_title_*`
 *     triggers, because they are defined ON that table. They are recreated here
 *     verbatim; without this the roster projection silently stops updating.
 *   - `session_index_projection_source` LEFT JOINs this table. The rename is
 *     safe with the view in place (verified against the live schema): SQLite
 *     scans for references to the OLD name, `session_titles_new`, and finds
 *     none. The view is deliberately left untouched.
 */
const sessionTitleCascadeMigration: HrcMigration = {
  id: '0046_session_titles_cascade',
  apply(db) {
    db.exec(`
      CREATE TABLE session_titles_new (
        host_session_id TEXT PRIMARY KEY
          REFERENCES sessions(host_session_id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        source          TEXT NOT NULL CHECK (source IN ('generated','manual')),
        model           TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      INSERT INTO session_titles_new (
        host_session_id, title, source, model, created_at, updated_at
      )
      SELECT host_session_id, title, source, model, created_at, updated_at
      FROM session_titles;

      DROP TABLE session_titles;

      ALTER TABLE session_titles_new RENAME TO session_titles;

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

export const sessionTitleCascadeMigrations: readonly HrcMigration[] = [sessionTitleCascadeMigration]
