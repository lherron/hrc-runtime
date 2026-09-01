# Federation ordered retirement

Federation v1.3 does not move an established scope. It provides one
authenticated, idempotent operation that permanently retires a scope on its
old home:

```bash
hrc federation retire <scope> --reason <text>
```

The old home performs the operation under the scope authority lock:

1. Refuse unless its local ledger names this node as the scope's home.
2. Refuse while any runtime for the exact scope is live.
3. Durably change the local ledger row from `active` to `retired`.
4. Conditionally delete the shared registry row only if it still names the
   authenticated old home.

The local fence is written first and survives registry deletion. If the
registry write is unavailable, the result is `fenced-registry-pending` and is
retryable: the scope is unavailable, never double-owned. Repeating the same
operation completes the conditional delete. A completed repeat is idempotent.
A non-home request is refused without mutation.

The shared registry contains no retirement tombstone. Once deletion succeeds,
another node may establish the now-unbound scope through the ordinary virgin
establishment path. That is fresh continuity: the new home does not inherit the
old session, runtime generation, placement metadata, or authority lineage. The
old home's permanent fence prevents local resurrection.

After retirement, follow the cache refresh and visible-replay procedure in
[Binding registry rebuild and cache refresh](federation-binding-registry-rebuild.md).
