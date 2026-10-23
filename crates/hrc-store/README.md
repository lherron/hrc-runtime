# Native HRC storage — implementation in progress

This crate implements existing-only SQLite storage against Bun's canonical schema. It has no migration authority, daemon, broker execution or public SQL handle. Reads use `Store::read_snapshot`; mutations compose on `WriteTx` under an immediate transaction. Commit hints publish after the outer commit and remain process-local. External Bun writers require fresh snapshots; hints do not represent their writes.

`hrc-domain::store` holds typed records and the pure UTF-16-preserving `JsString`/`JsValue` representation. Store JSON emission follows the observed JS Number, property-order and surrogate rules. Existing API-fed domain/kernel facades remain unchanged. The qualified Bun baseline is `release-20261023084446986-41220`, source `fbc32e43be56885b30a81df5128d2186fe32376d`, migration through `0123_participant_fresh_continuation_reason`. The collective collator matches that tuple's observed en-US locale, including its independence from shell locale variables on the qualified platform. Other producer/platform locale behavior needs ordinary compatibility refresh.

The `rusthrc` binary is a fixed-scenario scratch test driver, not the shipping command implementation. It admits only real paths under `/tmp/hrcp1-*` (including `/private/tmp` aliases), rejects symlink escapes before SQLite open, and requires explicit paths. This admission restriction belongs to the driver; the library accepts caller-supplied explicit paths. The existing shared Cargo target must be used:

```sh
CARGO_TARGET_DIR=/Users/lherron/praesidium/hrc-runtime/crates/target \
  cargo build --manifest-path crates/Cargo.toml -p hrc-store --offline --locked
python3 crates/hrc-store/e2e/serialization_e2e.py \
  --binary /Users/lherron/praesidium/hrc-runtime/crates/target/debug/rusthrc \
  --release /Users/lherron/.bun/install/hrc-runtime-releases/release-20261023084446986-41220 \
  --artifacts /absolute/durable/evidence
```

External E2E scripts initialize disposable scratch with the real installed canonical Bun factory, run native subjects with no Bun executable/socket, then use unchanged Bun for independent controls/readback. The OS discriminator additionally denies network access and child executables, with separate positive and denial controls. The snapshot scenario pins a real reader while an independent Bun writer commits.

The pure reply-schema compiler/validator uses native UTF-16 ECMAScript regular expressions and bundled immutable 2020-12 meta-schema data. Qualification compares actual unchanged Bun outcomes, including strict compilation, allErrors ordering, unused definition validation, conditional annotations, failed-ID registration and catchable nonprogressing recursion. This API remains under qualification: additional regex/reference/malformed-input controls and integration into legacy mail create/ack/origin writes are still required. It never invokes a JavaScript runtime.

This is a source milestone, not P1 readiness or parity qualification. Remaining work includes legacy mail envelope/federated-origin and schema semantics, complete per-operation/direct-SQL coverage resolution, remaining maintenance/direct consumers and negative controls, the P0 runner/profile adapter, canonical installed native driver acceptance, and independent grading. No current scenario count substitutes for those obligations. P2/P7 implementation remains held. Durable red attempts and raw outputs live in T-11528's artifact directory, outside disposable databases.
