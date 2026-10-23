import type { HrcMigration } from './types.js'

/** T-11708: the lifecycle ledger owns all remaining event facts and recency. */
export const legacyEventsRemoval: HrcMigration = {
  id: '0125_legacy_events_removal',
  apply(db) {
    db.exec(`
      DROP TRIGGER IF EXISTS session_index_event_insert;
      DROP TABLE IF EXISTS events;
    `)
  },
}
