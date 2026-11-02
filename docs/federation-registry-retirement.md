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
4. Disable continuation reuse for the scope's continuity sessions and delete
   its continuity selectors before releasing registry authority.
5. Conditionally delete the shared registry row only if it still names the
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

Registry deletion also removes live birth designations and records the last
home in `binding_retirement_audit`. That audit supports later routing hints;
it is not a binding or a shared fence. Current native implementations are
`crates/hrc-native/src/server/placement/federation/retirement.rs` and
`registry_listener.rs` in the same directory; the retained Bun implementation
is `packages/hrc-server/src/federation/retirement.ts`.

After retirement, follow the cache refresh and visible-replay procedure in
[Binding registry rebuild and cache refresh](federation-binding-registry-rebuild.md).
