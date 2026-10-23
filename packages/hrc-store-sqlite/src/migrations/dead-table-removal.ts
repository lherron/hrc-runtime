import type { HrcMigration } from './types.js'

/**
 * Tables the T-11540 audit proved dead in HRC's store (T-11542). Each one has no
 * production reader or writer left; their indexes go with the table. No trigger
 * or view names any of them, and every foreign key among them points outward
 * (child side), so dropping them cannot cascade into a live table.
 *
 * The `hrcmail_delivery_*` group moved to ACP's injector DB on 2026-09-19. That
 * DB creates its own schema (`ensureSchema` in hrc-injector-core) and never runs
 * these migrations — it has no `hrc_migrations` table — so this drop cannot
 * reach the live copies there.
 */
export const DEAD_TABLES = [
  // Legacy mail, retired at the T-07616 flag day (2026-08-27).
  'hrcmail_envelopes',
  'hrcmail_ingress_receipts',
  'hrcmail_federated_origins',
  // State.sqlite copies of the delivery tables now owned by ACP's injector DB.
  'hrcmail_delivery_intents',
  'hrcmail_presentations',
  'hrcmail_birth_refusals',
  'hrcmail_delivery_expiries',
  'hrcmail_failure_notices',
  // Federation message path retired 2026-08-27.
  'federation_scope_retirements',
  'federation_accepted_requests',
  'federation_peer_acceptances',
  'federation_outbox_deliveries',
  // EPR grant flow; its only client (arris EPR) was deleted 2026-09-24.
  'external_registration_grants',
  'local_bridges',
  'steer_contributions',
  'broker_turn_attributions',
  'session_index_backfill_evidence',
] as const

export const deadTableRemoval: HrcMigration = {
  id: '0124_dead_table_removal',
  apply(db) {
    for (const table of DEAD_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`)
    // The kicker's envelope tail moved to the injector DB with the delivery
    // tables; HRC's own project-event streams keep their rows.
    db.exec("DELETE FROM wrkq_ledger_cursors WHERE stream = 'envelope'")
  },
}
