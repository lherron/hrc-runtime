# HRC's cardo conformance profile

`run.py` imports `wire_suite.py` and `embed_suite.py` from Cargo's checkout of
exactly the revision pinned in `crates/Cargo.toml`. It never imports another
project's moving checkout. The suites start private real rusthrc processes on
short scratch roots; no installation or shared daemon is used.

HRC has six unfenced owner operations, no cardo idempotency, no graphs, no
loaded directory and no attacher. No upstream fake is needed for generic
conformance: those checks do not birth HRC seats. HRC's owner-operation behavior
and HRC-owned replay are exercised by `crates/hrc-native/e2e/kernel_fold.py`,
using that fixture's existing private aspd, broker and wrkqd.

The embedder profile names rusthrc's captured log as the log destination,
declares `kernel.stop` unsupported and directory reload not applicable. Wire
classes remain enabled; cardo's suite decides applicability from discovery.
The only type-only probe provider is the suite's registry-generation probe.

Run after building rusthrc:

```
python3 conformance/hrc/run.py --binary crates/target/debug/rusthrc \
  --cardo /path/to/pinned/cardo --artifacts /tmp/hrc-conformance
```

The cardo CLI must be built from the same pin. `just conform-hrc` supplies it.

The profile is staged for cardo T-13596. It will join `just verify` once that
importable suite and the ops-only wire-suite audit are pinned; the current
landing gate does not claim embed conformance.
