# Binding registry rebuild from node ledgers

The binding registry at
`~/praesidium/var/state/federation/binding-registry.sqlite` is reconstructible
from the union of every node's local `placement_ledger` and
`federation_scope_retirements` epoch fences. The rebuild chooses the highest
placement epoch for each ScopeRef and refuses conflicts at the same epoch. A
fence at or above the highest ledger rebuilds a durable retired row; an active
ledger above the fence rebuilds active authority. Retirement is never collapsed
to virgin. The command never overwrites an existing registry.

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
     "SELECT scope_ref,state,home_node_id,retired_home_node_id,successor_node_id,placement_epoch,birth_class FROM binding_registry ORDER BY scope_ref;"
   ```

5. Back up the current registry with `sqlite3 .backup`, stop its listener, move
   the verified rebuilt database into the canonical path, and restart the
   pinned svc service. Keep establishment/rebind disabled until registry
   consults agree with the active local rows.

The registry and local databases use WAL mode. Never reconstruct by copying a
live `.sqlite` file without its WAL or by selecting a lower epoch to make a
conflict disappear.

An orphan retirement fence—one whose retired-home ledger row is absent from
the supplied backups—is not evidence that the fence is stale. On its source
node it remains an effective fail-closed fence because no later active local
ledger epoch proves that authority returned there. The rebuild refuses that
scope because the fence alone cannot reconstruct immutable birth class and
authority provenance. Recover the missing WAL-aware node backup or otherwise
restore the matching ledger evidence before retrying; never delete or ignore
an orphan fence merely to make the rebuild converge.
