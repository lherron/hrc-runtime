import type { HrcMigration } from './types.js'

// Keep forever. No FK cascade: rotating or retiring a seat must retain history.
export const seatHandoffs: HrcMigration = {
  id: '0130_seat_handoffs',
  apply(db) {
    db.exec(`
      CREATE TABLE seat_handoffs (
        id TEXT PRIMARY KEY,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','acknowledged')),
        etag INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        note TEXT NOT NULL DEFAULT '',
        legacy_scope TEXT
      );
      CREATE UNIQUE INDEX seat_handoffs_pending ON seat_handoffs(scope_ref,lane_ref) WHERE state='pending';
      CREATE INDEX seat_handoffs_project ON seat_handoffs(project_id,created_at);
      CREATE INDEX seat_handoffs_seat ON seat_handoffs(scope_ref,lane_ref,created_at);
    `)
  },
}
