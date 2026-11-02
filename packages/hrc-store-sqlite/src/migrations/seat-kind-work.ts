import type { HrcMigration } from './types.js'

// Classification is refreshed from ASP declarations by the native owner.
export const seatKindWork: HrcMigration = {
  id: '0129_seat_kind_work',
  apply(db) {
    db.exec(`
      ALTER TABLE continuities ADD COLUMN seat_kind TEXT NOT NULL DEFAULT 'adhoc'
        CHECK (seat_kind IN ('task','standing','adhoc'));
      ALTER TABLE continuities ADD COLUMN seat_work_json TEXT NOT NULL DEFAULT '{"kind":"none"}';
      ALTER TABLE continuities ADD COLUMN seat_work_etag INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE seat_kind_policies (agent_id TEXT PRIMARY KEY, placement_json TEXT NOT NULL);
      UPDATE continuities SET seat_kind='task',
        seat_work_json=json_object('kind','task','taskId',task_id)
        WHERE task_id GLOB 'T-[0-9]*' AND substr(task_id,3) NOT GLOB '*[^0-9]*';
    `)
  },
}
