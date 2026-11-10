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
`conformance/hrc-parity/run.py` remains for the hand-run
comparison commands, checker controls and listed native parity drivers. They
stay until their last caller is retired in the later driver sweep.

`status.json`, `metrics.json`, and `client_errors.json` freeze the default gate
vectors at `ac3fa617` (T-13065). Unmodified drivers ran against Bun before any
implementation edits: status 49 PASS + 2 declared checkpointed-WAL divergences,
metrics 7 PASS, client errors 28 PASS. Raw Bun responses, original drivers,
ordered before/after results, capture/acceptance scripts and negative controls
are in `/Users/lherron/praesidium/var/wrkq-artifacts/T-13065/`. Each fixture names
its source revision, driver hash and raw capture hash. Expected bytes never come
from running the native subject.

Status retains all 17 states, both output modes and all 17 store-effects checks.
Suite runtime/state roots are replaced by placeholders; PATH supplies no ambient
tmux. The noisy and stalled tmux cases still supply their own executable. The
migration ids are the captured Bun empty-ledger pending list; they construct
missing/partial/unknown ledgers without reading TypeScript. WAL cases create a
real store with `rusthrc store migrate`, remove forward ids from its ledger, and
hold a writer open for live-WAL reads. They check that the live WAL has frames
and that status does not mutate store/control files. Invalid ledger fixtures
are deliberately made with Python sqlite3: native migration would repair or
refuse those states. `frozen_oracle.py` remains the only forward-id projection.

Status has three named native contracts. A checkpointed WAL without sidecars
must read the same schema as live-WAL, rather than Bun's unreadable verdict. A
tmux timeout reports unknown availability/running under the declared 750ms idle
and 5000ms total budgets. Large tmux output must contain all 12000 named sessions
and the empty lease diagnostics declared by `server_status.rs`; Bun's captured
JSON was truncated, so it cannot supply that literal. `bunCapture` retains the
original observations next to these declared expected results. Every status
vector now compares the complete exit/stdout/stderr, including these contracts;
the two previously unsupported checkpointed-WAL vectors are now PASS obligations.

Metrics preserves its five native contracts as explicit expected observations:
search record fields/byte count, CLI-only retention, opt-out, the 4096-byte bound
and oversized context removal, and nonfatal storage failure. The two Bun vectors
compare complete command responses and normalized usage records, with native bin,
byte/exit accounting and finite nonnegative RPC durations checked separately.
Metrics isolation continues to attribute production growth to spawned suite PIDs.
Client errors retain all seven socket/body states and four command spellings.
Only explicit private roots are normalized in their error messages.

No default case was dropped. As with `differential.py`, optional external-daemon
vectors require an explicit expanded `--fixtures` corpus; the default corpus
refuses an expanded manifest. The default gate never assumes an external daemon
or captures machine-dependent counts, PIDs, release ids or paths. Fixture writes
are offline, deliberate changes; the runners have no capture/update mode.
