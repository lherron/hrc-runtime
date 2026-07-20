# Binding registry rebuild from node ledgers

The binding registry at
`~/praesidium/var/state/federation/binding-registry.sqlite` is reconstructible
from the union of every node's local `placement_ledger`. The rebuild chooses the
highest placement epoch for each canonical ScopeRef and refuses conflicting
rows at the same epoch. It never overwrites an existing registry.

This is a recovery procedure, not normal rebind choreography:

1. Stop federation establishment/rebind writes on every node. Resolve any
   known registered-but-not-yet-established crash window by retrying the
   establishment first; until its local row exists, that newly registered row
   is intentionally not present in the ledger union.
2. Capture each node's HRC SQLite database with a WAL-aware backup. For example:

   ```bash
   sqlite3 ~/praesidium/var/state/hrc/state.sqlite \
     ".backup '/tmp/max3-state.sqlite'"
   ```

   Repeat on `svc`, `lab`, and every node that has ever held a binding, then
   place those backup files together on the recovery node.
3. Build a new registry at a fresh path:

   ```bash
   bun scripts/rebuild-binding-registry.ts \
     /tmp/binding-registry.rebuilt.sqlite \
     /tmp/svc-state.sqlite \
     /tmp/lab-state.sqlite \
     /tmp/max3-state.sqlite
   ```

   A same-epoch conflict is a hard refusal and must be investigated; choosing
   a row heuristically would recreate split authority. Older epochs are ignored
   because epochs never regress.
4. Compare the emitted counts with the source inventory and inspect the staged
   registry before activation:

   ```bash
   sqlite3 /tmp/binding-registry.rebuilt.sqlite \
     "SELECT scope_ref,home_node_id,placement_epoch,birth_class FROM binding_registry ORDER BY scope_ref;"
   ```

5. Back up the current registry with `sqlite3 .backup`, stop its listener, move
   the verified rebuilt database into the canonical path, and restart the
   pinned svc service. Keep establishment/rebind disabled until registry
   consults agree with the active local rows.

The registry and local databases use WAL mode. Never reconstruct by copying a
live `.sqlite` file without its WAL or by selecting a lower epoch to make a
conflict disappear.
