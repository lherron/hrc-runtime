# F0 namespace inventory and reconciliation

The F0 cutover must finish with one canonical binding for every pre-federation
ScopeRef and no unretired continuity on another node. The tooling is:

```bash
bun scripts/reconcile-federation-namespace.ts inventory \
  --registry /path/to/binding-registry.sqlite \
  --node max3=/path/to/max3-state.backup.sqlite \
  --node svc=/path/to/svc-state.backup.sqlite \
  --advisory-log /path/to/advisory-creations.jsonl

bun scripts/reconcile-federation-namespace.ts reconcile \
  --registry /path/to/binding-registry.sqlite \
  --node max3=/path/to/max3-state.backup.sqlite \
  --node svc=/path/to/svc-state.backup.sqlite \
  --select agent:clod:project:hrc-runtime:task:T-06614=max3 \
  --yes > /tmp/f0-reconciliation.json

ssh -o BatchMode=yes svc -- \
  bun /path/to/reconcile-federation-namespace.ts apply \
  --node-id svc \
  --state /path/to/live/state.sqlite \
  --artifact /path/to/node-local/f0-reconciliation.json \
  --yes
```

Use `--dry-run` first, then replace it with `--yes` only after reviewing the
selection. Copy the emitted artifact to each losing node and run `apply`
node-locally there; the tool never SSH-mutates another node. All commands emit
JSON. `remainingUnreconciled` is the exact current F1-enablement blocker list;
F1 remains blocked while `f1EnablementBlocked` is true.

## Cross-node inventory

Inventory deliberately uses operator-provided SQLite backup exports. It does
not copy live `state.sqlite` files and does not need a cross-node HRC RPC. On
each remote node, create an export with SQLite's online backup command while
the daemon remains live:

```bash
ssh -o BatchMode=yes max3 \
  sqlite3 /Users/lherron/praesidium/var/state/hrc/state.sqlite \
  '.backup /tmp/hrc-f0-max3-state.sqlite'
scp max3:/tmp/hrc-f0-max3-state.sqlite /tmp/hrc-f0-max3-state.sqlite
ssh -o BatchMode=yes max3 rm /tmp/hrc-f0-max3-state.sqlite
```

Repeat for every node in the declared roster (`svc`, `lab`, `max3`) and pass
the declared nodeId on each `--node`; never derive node identity from a host,
path, or hostname. The `.backup` step includes committed WAL state safely. A
bare filesystem copy of `state.sqlite` is not a valid inventory input.

The optional advisory input is normalized JSONL, one creation per line:

```json
{"scopeRef":"agent:clod:project:hrc-runtime:task:T-06614","nodeId":"svc","occurredAt":"2026-07-20T02:00:00.000Z","decision":"would_refuse_off_home"}
```

The soak operator extracts these records from structured
`federation.summon_gate.refusal` advisory events. The inventory combines them
with sessions, last runtime activity, continuation presence, placement rows,
retirement marks, and the binding registry.

## Five-step ops contract

T-06616 owns execution across the collective:

1. Create `.backup` exports on every node and run `inventory` across them.
2. Review the blocker report and select one canonical node per ScopeRef.
3. Run `reconcile` where the svc registry is local. It imports an unbound
   canonical placement through `BindingRegistry.establish`, or moves an
   existing different binding through `BindingRegistry.compareAndSwap`, then
   emits a versioned, node-addressed retirement artifact. It does not mutate
   node state stores.
4. Copy the artifact to each losing node and run `apply --node-id ... --state
   ...` node-locally. `apply` mutates exactly the explicit writable store it is
   handed, writing a synchronous local `federation_scope_retirements` mark
   without deleting sessions or continuations. Never replace a live WAL
   database with a modified export.
5. Take fresh `.backup` exports and re-run `inventory`. Zero
   `remainingUnreconciled` entries is the F1-enablement clear condition.

The summon gate checks the retirement mark after the gate-dark check but before
the active local ledger. This ordering is required because a pre-federation
loser can legitimately still have an active ledger row. In advisory mode the
gate logs the would-be `scope-retired` refusal; T-06616 verifies actual refusal
after enforcement is enabled.

Re-running the same reconciliation leaves the registry unchanged and emits the
same semantic retirement steps. Re-running `apply` on an already-retired store
is a no-op. A conflicting second canonical selection is rejected instead of
silently unretiring a node. If an interruption occurs after registry import but
before all node-local applications, repeat the same five-step flow:
establishment/CAS and retirement writes converge idempotently.
