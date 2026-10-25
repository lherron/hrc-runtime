# rusthrc daemon

`cargo build --manifest-path crates/Cargo.toml -p hrc-native` builds
`crates/target/debug/rusthrc`. Run `rusthrc server` (or `server serve`) with
`HRC_RUNTIME_DIR` and `HRC_STATE_DIR` pointing to isolated scratch roots.
The database must already have the exact current Bun migration set. Rust
never creates or migrates it. Production installation is not authorized by N1.

The first N1 landing provides schema admission, the Unix HTTP listener,
Bun-compatible ownership files, health/status, session resolve/list/by-host,
and stored runtime listing. Other routes answer Bun's unknown-route 404.
Provisioning, claims, participant registration and the remaining N1 route
semantics are subsequent N1 work; this landing does not claim N1 parity.

Schema admission extracts migration names from the checked-out Bun migration
source graph at build time. It checks both a read-only connection and the
write handle before any pragma or write. Missing or extra names refuse boot.
Shutdown closes the listener/store and removes only this owner's control
socket and ownership files; it never kills a broker.

The workflow test creates its schema with Bun's real migrator, then drives the
native binary as a subprocess. It tests unknown/incomplete schema refusal
without file changes, durable session creation and repeat resolution, one
lifecycle row, a refused competing owner and graceful shutdown:

```
python3 crates/hrc-native/e2e/foundation.py \
  --binary crates/target/debug/rusthrc --artifacts /tmp/hrc-native-results
```

For installed Bun scratch comparisons, copy the named installed release under
the scratch root with a parent other than `hrc-runtime-releases`. A daemon
running from the actual atomic release tree can prune shared releases even
when runtime/state roots are isolated. The copy must report `unmanaged`, emit
no `server.start.release_prune`, and leave the shared release list unchanged.
