import type { HrcMigration } from './types.js'

// T-12185 (seat-annotations r1.1 §3): namespaced, kinded, opaque JSON records
// attached to a seat (host_session_id '') or one of its generations. Rust
// (crates/hrc-store/src/annotations.rs) owns admission; Bun owns the schema.
export const seatAnnotations: HrcMigration = {
  id: '0128_seat_annotations',
  apply(db) {
    db.exec(`
      CREATE TABLE seat_annotations (
        scope_ref       TEXT NOT NULL,
        lane_ref        TEXT NOT NULL,
        subject         TEXT NOT NULL CHECK (subject IN ('seat','generation')),
        host_session_id TEXT NOT NULL DEFAULT '',
        generation      INTEGER,
        ns              TEXT NOT NULL,
        kind            TEXT NOT NULL,
        id              TEXT NOT NULL,
        body_json       TEXT NOT NULL,
        fence_json      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        updated_by      TEXT NOT NULL,
        PRIMARY KEY (scope_ref, lane_ref, host_session_id, ns, kind, id)
      )
    `)
    db.exec(
      'CREATE INDEX seat_annotations_by_session ON seat_annotations (host_session_id, updated_at)'
    )
  },
}
