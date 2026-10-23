# Finite read qualification

This is a source-native qualification subset for lifecycle, runtime and run repository behavior. It does not qualify installed-native HRC, the complete P1 package, or downstream dispatch.

The private binary module is `crates/hrc-store/src/qualification_reads.rs`. The parent owns its two dispatch arms, all typed library APIs, builds, frozen binaries, gates, commits and pushes. This directory never builds or installs anything.

Run against an immutable parent freeze:

```sh
python3 crates/hrc-store/e2e/finite_reads/finite_reads_e2e.py \
  --identity /absolute/parent-freeze/identity.json \
  --artifacts /absolute/new-evidence-directory
python3 crates/hrc-store/e2e/finite_reads/verify.py /absolute/new-evidence-directory
python3 crates/hrc-store/e2e/finite_reads/controls.py /absolute/new-evidence-directory \
  --artifacts /absolute/new-controls-directory
```

The runner also accepts the parent's `--binary` and `--release` arguments, checking both against `identity.json` beside the binary. Output directories must be new. The Bun oracle imports the explicitly pinned immutable producer; it never modifies Bun source. All databases are fresh isolated `/tmp/hrcp1-finite-*` scratch state. Native execution has `PATH=/usr/bin:/bin` and a nonexistent scratch HRC socket. No daemon is required or started.

`observe(&mut Store)` executes fixed typed reads inside one coherent native read snapshot. The suite compares all returned records, fields, omissions and order with unchanged Bun, then checks independent expected identities so two empty or equally wrong results cannot pass. It runs initial holes/deleted-highest, further highest deletion, incarnation replacement, malformed lifecycle payload, and all-events-deleted states. Page allocated high-water remains distinct from tail retained MAX. Replay uses an actual serialized UTF-8 visitor budget and preserves the visited refused row separately from accepted rows.

Original repository page/tail behavior uses the parent's signed `repository_page` and `repository_tail` APIs: zero, -1, -2, 10001, negative after, exclusive before and stale incarnation are measured directly. Bun's negative-tail single-pop quirk is preserved. Native positive bounded observations have a separate `nativeBoundedRefusals` result: zero/large limits and negative after must refuse with `malformed_request`. The oracle does not fabricate a Bun equivalent for this native-only contract. Every original repository output is still compared exactly.

`mutate(&mut Store)` measures omitted patches, JSON null versus SQL NULL, status-change timestamps, activity, active-run clearing, wrong app-run ownership, run terminal monotonicity, explicit resurrection, status and nullable clearing. Full before/after return records and final logical SQLite state are compared with Bun. `clearRunId` and `ownershipAfter` are the full adjacent runtime observations around the refused ownership write.

The logical checker captures schema, all tables, FTS and `sqlite_sequence` immediately before and after each Bun/native reader **process group**. It does not claim separate filesystem snapshots between each method inside a group. The native connection is read-only/query-only. A separate real Bun `updateActivity` command must be rejected by the exact same passivity checker; changed WAL length is not used as evidence. SQLite backups retain fixture/final/mutation state coherently, and temporary state is removed on success or failure.

`method-map.json` retains all 42 agreed original method identities and P0 IDs, original source hashes, output slots and raw extraction rules. `inputs.json` describes their typed filters/inputs, including absent versus null keys. These are method-to-observation mappings, not a claim that all P1 operation obligations are closed. `PresentationQueries` keyed >256 seat projection remains a separate parent-owned qualification obligation; legacy all-runtime lists do not stand in for it.

Raw receipts are recorded through the parent's `conformance/hrc-parity/native_capture.py` `ProcessRecorder`: actual argv/PID/executable hashes/status/stdout/stderr/timing/stdin metadata and native hashes before/after each process. Source/control hashes and copies, immutable Bun producer metadata, and parent build/compiler/source provenance are retained. `verify.py` rederives results from raw outputs and command receipts; it does not trust summary flags. Native output is direct JSON; Bun output is JSON under `result`, as recorded in the method map.

The 14 external verifier controls first require a passing real baseline, then reject missing command/field/method/operation, omitted newest row, wrong generation/order, zero effect, stale MAX-as-head, missing mutation evidence, NULL/empty-source conflation, missing signed-limit case, lost negative-tail pop, and acceptance at the bounded zero-limit boundary. Several controls alter both Bun and native raw outputs and their duplicate command receipts coherently, so parity equality alone cannot catch them. Each negative retains its actual child command/output and a delta sufficient to reconstruct the altered artifact from the unchanged baseline.

Historical reds remain under `T-11528.finite-reads` artifacts: invalid queue-uniqueness fixture (01), missing native dispatch (01/07), wrong SQLNULL scenario input (06), initial zero-limit distinction (09), and insufficient checker assertions/fixture filters (earlier controls). The parent retains the v4 macro build red (336). Their historical source/provenance limits remain unchanged.
