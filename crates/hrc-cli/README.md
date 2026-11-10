# rusthrc operator CLI

`hrc-native` owns the `rusthrc` executable and dispatches CLI work to this
library. Grammar, help and execution are entirely Rust-owned. `surface.json`
is hand-maintained source, including complete help text, footnotes, options,
arguments and native-only declarations. Edit it directly when changing the
CLI contract; every group and leaf parses and runs natively, with no Bun exec.

`admin events drain` never migrates a dead ledger. It reports the Rust runner's
`store_below_baseline` or `store_ahead` refusal for unsupported sets. For pending
forward migrations, run `rusthrc store migrate <path>` first, then drain again.

Run the byte/exit comparator:

```
python3 crates/hrc-cli/e2e/differential.py --binary crates/target/debug/rusthrc --artifacts /tmp/n5-report
```

Add `--runtime-root /tmp/<isolated-root>/run` for daemon cases. Supply
`--oracle <copied-release>/packages/hrc-cli/bin/hrc.js` for the named installed
Bun reference. Never point mutation cases at production. Reports retain both
stdout/stderr streams, exit status, the exact argv and declared normalization.

Atomic packaging builds both native executables, reuses each previous binary
only when its full Rust/shared input digest matches, and links `rusthrc` through
the same current-release indirection as `hrc`. Mable installs from the canonical
checkout. `--version` reads the releaseId/sourceCommit beside its own executable.
