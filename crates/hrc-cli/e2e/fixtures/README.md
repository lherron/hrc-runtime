# CLI gate literals

`differential.json` freezes all 229 default cases of `differential.py` at
`1cadeb73`. Every row's exit/stdout/stderr was captured directly by running
`bun packages/hrc-cli/bin/hrc.js <argv>` from that unchanged checkout. Source
commit, original driver hash, raw capture hash and capture command are included.
The raw capture and repeatable capture scripts are in task T-13063's artifact
directory. No expected bytes were captured from the native executable.

Some original cases intentionally did not compare Bun: native-only commands,
their parents, and native usage refusals. Those rows retain the raw Bun result
for provenance and carry `nativeContract`, derived from the hand-owned
`surface.json` and the native grammar contract. They now assert exact bytes,
including the errors which previously asserted only a prefix/suffix.

Only `grammar:server status extra --json` observes the environment. Its Bun
capture and native invocation use PATH `/nonexistent` so tmux availability and
version do not vary across machines. Its explicitly supplied private runtime
and state roots are replaced by `<runtime-root>` and `<state-root>`. The driver
also retains timestamp normalization and `frozen_oracle.py`'s forward-migration
projection. The server help appendix remains an explicit native extension.

The ordered case/argv manifest must equal the cases independently generated
from `surface.json` plus the fixed grammar list. The independent execution-suite
map must also equal all declared commands. Missing, duplicate or added cases
fail; fixture refresh is a deliberate reviewable change, never automatic.
`--fixtures` permits an explicit corpus for the optional isolated daemon cases;
the default grammar corpus refuses that expanded case set rather than silently
skipping it. `--only-differential` runs these cases without the separately owned
status, metrics, transport, caller and native-surface drivers. The cargo gate
continues to run those drivers by default.

The differential no longer imports or runs the TypeScript conformance inventory.
It retains command-to-execution-suite obligations from the native grammar. The
old route/store/job/file/export discovery only assigned qualification labels;
it did not execute native assertions. Those source labels and their UNSUPPORTED
agreement are removed. Native route declarations/behavior remain asserted by
`crates/hrc-native/src/server/front/accounting.rs` and native route suites.
`conformance/hrc-parity/run.py` and `inventory.ts` remain for the hand-run
conformance `run`/`inventory` commands, checker controls, native parity drivers,
and the server attribution test. Their retirement belongs to the driver sweep.
