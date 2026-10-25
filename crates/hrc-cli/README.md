# rusthrc operator CLI

`hrc-native` owns the `rusthrc` executable and dispatches CLI work to this
library. Runtime execution is entirely Rust. `surface.json` is build-time data
from Bun's command registrations, including complete help text and footnotes.
Regenerate it with `bun crates/hrc-cli/generate-surface.ts`; `--check` detects drift.

N5 is being delivered incrementally. Current execution: runtime list (including
pagination), session list and session resolve. Runtime inspect JSON and status
have initial implementations still awaiting selector/render qualification.
Unimplemented execution fails explicitly; help availability is not execution
coverage. The differential result file lists those gaps.

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
