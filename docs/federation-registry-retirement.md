# Federation registry retirement contract

A ScopeRef has exactly one authoritative registry state: active, retired, or
absent because it has never been born. Retired is a durable tombstone and must
never be returned as unbound.

The registry uses one discriminated row. Common identity fields survive every
transition: placement epoch, birth class, authority provenance, original
creation time, and last update time. Active rows carry a home and establishment
provenance. Retired rows carry the retired home, retirement time and reason,
and a nullable successor. A null successor is an explicit terminal bar.
State-specific SQL checks reject mixed active/retired shapes.

Retirement is fence-first:

1. Archive the old continuity and install a node-local epoch fence at the old
   home, including when the successor is the same node.
2. CAS the exact active `(old home, E)` registry row to retired at high-water
   `E`.

The fence suppresses local ledger authority at epochs `<= E`. A later active
ledger above the fence is authoritative. Cached delivery to the retired home
is redirected to `(successor, E+1)`; a terminal fence refuses without a
redirect. Epoch exhaustion refuses instead of wrapping.

Only the disclosed successor can activate. The registry transaction computes
`E+1` and preserves birth class, authority provenance, and original creation
time. An eligible policy-born summon may consume the tombstone; generic
mechanism-born activation is refused. Retargeting a disclosed successor burns
an epoch so two different nodes are never named at the same successor epoch.

Tombstones and fences have no TTL. Registry rebuild consumes the union of all
placement ledgers and all local fences, taking the highest epoch and refusing
same-epoch conflicts. See
[federation-binding-registry-rebuild.md](federation-binding-registry-rebuild.md)
for the recovery procedure and
[federation-namespace-reconciliation.md](federation-namespace-reconciliation.md)
for the fence-first operational flow and the exact one-time F0 repair.
