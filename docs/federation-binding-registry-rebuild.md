# Binding registry rebuild and cache refresh

The shared binding registry contains active `ScopeRef -> homeNodeId` rows only.
It is reconstructible from the union of active node-local `placement_ledger`
rows. A node-local `retired` row is a permanent fence on that node; it is not a
shared tombstone and must never be imported as an active registry binding.

This is a recovery procedure, not a relocation mechanism. Federation v1.3 has
no movement operation. If two node backups contain active rows for the same
scope with different homes, the rebuild refuses the conflict. An operator must
investigate it; selecting a winner would conceal split authority.

## Rebuild

1. Stop all registry writers and federation establishment on every node.
2. Take WAL-aware SQLite backups of every node store. Never copy a live
   `state.sqlite` without its WAL.
3. Build a new registry at a fresh path:

   ```bash
   bun scripts/rebuild-binding-registry.ts \
     /tmp/binding-registry.rebuilt.sqlite \
     /tmp/svc-state.sqlite \
     /tmp/lab-state.sqlite \
     /tmp/max3-state.sqlite
   ```

4. Compare the emitted counts with the source inventory and inspect the staged
   rows:

   ```bash
   sqlite3 /tmp/binding-registry.rebuilt.sqlite \
     "SELECT scope_ref,home_node_id,created_at,updated_at FROM binding_registry ORDER BY scope_ref;"
   ```

5. Back up the current registry with `sqlite3 .backup`. With writers still
   stopped, atomically replace it with the verified staged database, restart
   the registry host, and read every active binding back through the registry
   API before re-enabling establishment.

The rebuild never overwrites its output path. Retired local rows remain in the
node stores and continue to prevent that old home from re-establishing the
scope after the shared row is deleted.

## Refresh stale binding caches after retirement

Retirement fences the old home before deleting the shared row. Other nodes can
temporarily retain a stale cache hint naming that old home. The hint grants no
authority: the retired home refuses the request and the sender must surface the
failed delivery or retry after fresh discovery.

After an ordered retirement:

1. Confirm the retirement result is `retired` or `idempotent`, not
   `fenced-registry-pending`.
2. Refresh each participating daemon's binding cache by restarting it through
   that node's documented supervisor path. Do not edit SQLite cache rows.
3. Re-run `hrc target locate <scope> --json` from each node. The old home must
   report its durable local retirement fence and no summon authority; the
   registry must report unbound until a fresh establishment occurs elsewhere.
4. Replay only deliveries that visibly failed because of the stale hint, using
   their owning subsystem's retry surface. Never rewrite their destination or
   suppress a dead letter.
5. If a fresh establishment is intended, issue a new ordinary establishment on
   the chosen node. It creates new continuity; it does not inherit the retired
   home's session, binding metadata, or history.
