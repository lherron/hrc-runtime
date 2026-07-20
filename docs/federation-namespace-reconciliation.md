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
  --retire agent:cody:project:hrc-runtime:task:pin-probe \
  --exclude-virgin agent:mable:project:hrc-runtime:task:primary \
  --yes > /tmp/f0-reconciliation.json

ssh -o BatchMode=yes svc -- \
  bun /path/to/reconcile-federation-namespace.ts apply \
  --node-id svc \
  --state /path/to/live/state.sqlite \
  --artifact /path/to/node-local/f0-reconciliation.json \
  --yes

# Refresh the node backup after the fence is installed, then finalize the
# exact active -> retired registry CAS.
bun scripts/reconcile-federation-namespace.ts reconcile \
  --registry /path/to/binding-registry.sqlite \
  --node svc=/path/to/refreshed-svc-state.backup.sqlite \
  --retire agent:cody:project:hrc-runtime:task:pin-probe \
  --yes
```

Use `--dry-run` first, then replace it with `--yes` only after reviewing the
selection. Copy the emitted artifact to each losing node and run `apply`
node-locally there; the tool never SSH-mutates another node. All commands emit
JSON. `remainingUnreconciled` is the exact current F1-enablement blocker list;
F1 remains blocked while `f1EnablementBlocked` is true.

`--retire` and `--exclude-virgin` are deliberately not general-purpose escape
hatches. The script contains the exact operator-ruled ScopeRef allowlists and
rationale references. A retirement emits a node-local epoch fence and a
session-archive step. The first `reconcile --yes` reports `awaiting_fence` and
does not weaken registry authority. `apply` installs the old-home fence and
archives the session idempotently. A second reconciliation against a refreshed
backup sees the fence and performs the exact active-to-retired registry CAS.
This fence-first order is binding. A virgin exclusion only removes an
allowlisted, currently unbound scope from blocker accounting and is reported as
`pin-governed-deferred`. Any unlisted disposition or a retirement whose
node/epoch does not match the inventory aborts.

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
   emits a version 2, node-addressed retirement artifact. Explicit retirement
   dispositions remain active in the registry until their old-home fence is
   visible. The command does not mutate node state stores.
4. Copy the artifact to each losing node and run `apply --node-id ... --state
   ...` node-locally. `apply` mutates exactly the explicit writable store it is
   handed, writing a synchronous local `federation_scope_retirements` mark
   without deleting sessions or continuations. Never replace a live WAL
   database with a modified export.
5. Take fresh `.backup` exports, re-run `reconcile` to finalize any pending
   active-to-retired CAS, then run `inventory`. Zero
   `remainingUnreconciled` entries is the F1-enablement clear condition.

The summon gate checks the retirement mark after the gate-dark check but before
the active local ledger. This ordering is required because a pre-federation
loser can legitimately still have an active ledger row. In advisory mode the
gate logs the would-be `scope-retired` refusal; T-06616 verifies actual refusal
after enforcement is enabled.

Re-running the same reconciliation leaves an exact tombstone unchanged and
emits the same semantic retirement steps. Re-running `apply` on an already
fenced store is a no-op. A conflicting successor or epoch is rejected instead
of silently unretiring a node. If interrupted, repeat the same flow: fence
writes and registry CAS transitions converge idempotently.

## One-time T-06681 F0 tombstone repair

The original F0 run deleted three registry rows after installing their local
marks. Repair those exact identities after taking WAL-aware state and registry
backups:

```bash
bun scripts/migrate-t06681-f0-retirements.ts \
  ~/praesidium/var/state/federation/binding-registry.sqlite \
  /tmp/svc-state.sqlite /tmp/lab-state.sqlite /tmp/max3-state.sqlite \
  --dry-run

# Review the exact three records, then repeat with --yes.
```

The migration has no caller-selected identity rewrite inputs. It preserves the
mechanism-born identity for terminal `pin-probe`, and embeds Lance ruling A's
explicit policy provenance for `wrkq-refactor -> lab` and `mable:max3 -> max3`.
It refuses unless all three exact old-home ledgers and epoch fences are present.
