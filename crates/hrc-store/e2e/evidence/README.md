# Repository raw-evidence revalidation

This read-only, standard-library Python checker reconstructs retained native-store
repository evidence. It does not execute a producer, build, initialize/open a live
database, install, start a runtime, or change an index. SQLite access uses
`mode=ro&immutable=1`, `query_only`, and rejects backup sidecars and escaping links.
Use only retained coherent backups, never a live/WAL scratch path.

Run from the allocated parity worktree:

```sh
python3 -B crates/hrc-store/e2e/evidence/revalidate.py \
  --root /absolute/retained-regression-batch \
  --identity /absolute/independently-frozen-build/identity.json \
  --output /absolute/owned-artifacts/revalidation.json
python3 -B crates/hrc-store/e2e/evidence/inventory.py
```

The import interface is `revalidate(root, expected_identity=None) -> dict`.
Add this directory to `sys.path`, then `from revalidate import revalidate`.
`expected_identity` is the parsed independently supplied identity object, not a
copy chosen from the candidate batch. Missing pins or absent historical receipts
remain GAP. The CLI prints the same complete JSON it writes. Exit codes are
0 PASS, 1 FAIL, 2 GAP; contradictions dominate missing proof. Every required
assertion must pass for exit0. Parent aggregation must retain each row and its
qualification, rather than using passing scenario/assertion counts.

Each assertion has `id`, `family`, `status`, `reason`, and `receipts`. Source
assertions additionally carry exact source file/hash/line/column/expression.
`gapKind` distinguishes unimplemented source-expression/binding reconstruction
(`CHECKER_UNSUPPORTED`) from absent observations (`RAW_MISSING`). Both are
nonpassing. The `gaps` list is directly usable as a durable receipt/work request.
Unexpected/incomplete/malformed CLI inputs produce parseable nonpassing JSON.

`catalog.py` inventories every assertion in all 45 fixed top-level E2E scripts,
including each statically known loop key. Dynamic loops are retained explicitly.
`inventory.py` detects additions/removals/source drift. After reviewing a producer
change and its semantic adapters, `inventory.py --write` refreshes only this
checker's catalog. A catalog update is discovery, never new behavioral proof.
Historical evidence is not upgraded to the new source version.

## Evidence layout and identity

Each family retains its original E2E artifacts under `ROOT/<script_stem>/`.
The checker reads command stdout itself, never summary/comparison PASS fields or
stored differences/counts. `manifest.json`, when supplied, is an exact mapping of
all other relative files to SHA256. Standard P0 `SHA256SUMS` (digest, two spaces,
relative path) is also accepted. Both manifest files themselves are excluded;
when both exist they must agree with the exact same complete file set. Manifest validity is separate from semantics;
regenerating it after corrupting data must not repair a semantic failure.

For new captured batches, parent `conformance/hrc-parity/native_capture.py`
retains actual subprocess observations:

```text
ROOT/identity.json
ROOT/bun-release.json
ROOT/<family>/capture.json
ROOT/<family>/commands/NNNNN.json
ROOT/<family>/<original E2E receipt and coherent backup files>
```

`identity.json` contains:

```json
{
  "native": {"path":"/absolute/frozen/rusthrc", "sha256":"64 lowercase hex",
    "sourceHead":"40 lowercase hex", "sourceTreeSha256":"64 lowercase hex"},
  "bun": {"release":"/absolute/immutable/release", "sourceCommit":"40 lowercase hex"},
  "sources": {"family_stem":"fixed E2E source SHA256"},
  "controls": {"path/to/control-or-fixture":"SHA256"},
  "legs": [{"family":"family_stem", "receipt":"commands/00000.json",
    "command":["actual executable", "actual arguments"],
    "startedAt":1792767247.0, "completedAt":1792767248.0,
    "nativeBefore":{"path":"/absolute/frozen/rusthrc","sha256":"64 hex"},
    "nativeAfter":{"path":"/absolute/frozen/rusthrc","sha256":"64 hex"},
    "bun":{"release":"/absolute/immutable/release","sourceCommit":"40 hex"}}]
}
```

Timestamps are finite positive Unix seconds. Each actual command receipt must
have the same argv/command, interval, native before/after hashes and Bun identity,
plus integer exit, raw stdout/stderr, `captureComplete:true`, actual pid, and
`executable:{path,sha256}`. `capture.json` must retain the same complete legs and
no incomplete pids. Every semantic convenience receipt must match an actual
identified command's exit/stdout/stderr and argv when present. Equal filenames
are insufficient. JSONL producer stdout must match its unique captured command,
whose captured `stdin:{present,bytes,sha256,literalNewlineCount}` must match
retained `input.jsonl`. The earlier flat `stdinSha256` shape is also recognized.
`family/sources-before.json` and `sources-after.json` must agree, bind all root
family/control hashes, and match every retained `family/source/<path>` copy.

Root identity is compared with independent caller pins. The retained executable
is hashed and checked as a native image; the retained Bun release manifest must
agree. Captured per-leg observations remain necessary; hashing a current binary
cannot retroactively identify an old execution. The separate `identity/build-provenance` assertion verifies embedded build
receipts, compiler identity, unchanged compiler dependency files, every copied
compiler input, Cargo inputs and both include_str data dependencies against the
independent source-tree pin. The digest alone is insufficient. This bounded
provenance check does not establish every API/mapping obligation. Old269/294
lack captured identities and cannot close this law.

## Assertion-to-raw mapping

| Assertion group | Raw observations reconstructed |
| --- | --- |
| `reconciliation_e2e/cas-results` | Both command stdout arrays, all 39 exact case identities/order, typed changed outcomes and exact predicate winners; never comparison flags. |
| `reconciliation_e2e/cas-effects` | Full before/after coupled tables, exact winning SQL field/value patches, unchanged losing/unrelated rows, nonzero effects, final coherent backups and complete Bun/native equality. |
| `reconciliation_e2e/atomic-boundaries` | Native ordered before/within rollback/after rollback/within commit/after commit typed state, run/runtime ownership, exact lifecycle identity/payload, allocated heads, no precommit/rollback hints, exact committed hint ordering/content. |
| `read_predicates_e2e/query-values` | Full nonempty Bun/native result equality including all fields/order; exact input/terminal bounds, lifecycle recency, scope/task union, duplicates, LIKE escaping, roles and all generations. |
| `read_predicates_e2e/reader-passivity` | `before.json`, `bun-after.json`, `native-after.json` and final coherent backup dump. A final backup alone cannot prove each reader passive. |
| `mail_body_e2e/utf16-body` | Fixed 2004 input-unit cases, actual writer/opposite read/retry/reappend stdout; reconstructed bytes/decoded UTF16 bodies; physical row/fingerprint identity; success/conflict/blank refusal; complete before/after logical schema/tables and coherent backups. |
| `federated_origin_body_e2e/utf16-body` | Same raw legs with original UTF16 JSON preservation and zero local envelope effects. |
| `legacy_mail_mutations_e2e/commands-and-persisted-rows` | All23 command results, exact persisted ack/intent/counter rows and coherent backups, both writer directions. |
| `federated_origin_create_e2e/commands-and-persisted-rows` | All10 create/retry/missing-receipt results, exact full persisted rows/backups, surrogates and prototype-key behavior. |
| `{json_values,mail_json,reply_schema}_e2e/all-input-values` | Every retained input/output line in order, exact serialized bytes or reply-schema objects, fixed invalid suffix, declared fixtures/cardinality. Actual command/stdin identity is a separate required assertion. |
| `atomic_e2e/transaction-spill-observers` | Raw typed boundary states, successful inner writes before rollback, heads/rows/blobs, commit changes and actual ordered observers, exact large spill input/stub/hydration, part/refusal/assembly readback. |
| `atomic_e2e/invalid-part-effects` | Actual first/invalid part inputs, stored parts/blob before/within/after caught refusal and assembly, read-only refusal passivity, independent Bun control with only generated blob rowid/UTC clock normalized. |
| `repository_e2e/roster-atomicity` | Actual before/within/after full family state and independent unchanged Bun roster rows, real inserted claim before abort and exact restoration. |
| `session_e2e/lineage-metadata-cursor` | Actual lineage/continuation states, title provenance and metadata, rejected metadata before/after full core, cursor nonregression, unchanged Bun final readback. |
| `transcript_e2e/fts-transaction-readbacks` | Ordered typed turns and actual FTS results at eight boundaries: insert/unicode match, delete/rollback, token update, per-runtime cap, deletion, cursor/mark and invalid weights refusal. |
| `repository_e2e/family-operations` | Typed before/after family rows, first/repeat/conflict acceptance/artifact results plus unchanged conflict rows, permission composite identity, retained append order, emissions, buffers, displaced surfaces and bridge close. |
| `guards_e2e/refusals-passivity-crash` | Exact ordered native commands/refusal codes, compatible extra index, logical snapshots after EACH reader, real activity mutation control, append and crash/reopen rows. A preexisting committed WAL need not be empty. |
| `append_boundaries_e2e/raw-append-boundaries` | Both raw writer states, actual within-rollback work, exact caught-error and rollback restoration, committed head/row delta. Only declared ledger incarnation differs. |
| `title_reads_e2e/facade-surrogates-reappend` | Both actual reader outputs, all fields, provenance/omissions, surrogate preservation, reappend, non-ECMAScript whitespace. |

`source_checks.py` uses a restricted pure AST expression interpreter; it cannot
import, evaluate arbitrary Python, access a file, or launch a process. It checks
available fixed-source output predicates with explicit receipt bindings. These
rows have `scope:raw-output-only` and do not establish persisted effects. Native
self-attestation loops are ignored. Where a complete independent observation
adapter exists, named flag assertions link to that reconstruction and receive
`scope:semantic-source-assertion`. A claim flag cannot close its own assertion.
Missing bindings/dynamic source paths remain explicit checker gaps.

`invocations.py` reconstructs supported direct `subprocess.run` argv from the
captured fixed source and independently pinned entry arguments. Temporary paths
must match the exact source prefix and an observed eight-character tempfile
suffix. A binding requires a unique source call and unique complete identified
command with the entire argv equal; neither receipt filenames nor process order
select it. Family identity is validated first. Helpers, conditional/loop launches,
repeated argv, unsupported expressions and missing identity remain GAP. Process
status/stdout/stderr predicates consume that actual command, with source, entry,
capture and command anchors retained. These predicates remain raw-output-only;
they add no `coverageIdentities` or operation/effect proof.


Only the source-specific clock fields declared by the mail contracts and the
append-control ledger incarnation are normalized. Values, optional presence,
nulls, errors, order, cardinality, identities and other clocks are retained.
No generic omitted-field, empty-result or equality-only family waiver exists.

## Open obligations

The output deliberately retains unsupported source expressions and missing raw
receipts. In particular, old boolean-only execution/input/atomic/session/FTS/
repository artifacts cannot establish their behaviors. Expanded native receipts
close only their individually reconstructed assertions; they do not supply an
independent missing Bun boundary or a final physical snapshot. Atomic invalid
part/refusal passivity, missing-file noncreation, busy timing, title passivity,
roster failed-transaction atomicity and many per-operation receipts remain open
where absent. The generic persisted-operation rows remain GAP for families
without complete transaction/effect reconstruction. This harness is bounded
source qualification, not a full store approval.

The corrected coverage audit at `T-11528.coverage` supplies discovery links for
418 methods,81 direct-SQL files/95 templates and helper/migration declarations.
Those historical/partly dirty maps never produce semantic PASS here. Final
per-operation adequacy/closure remains with the parent. Consumers C01–C07 retain
their separate released `consumers/validate.py` + `rederive.py` law; this checker
does not substitute for it. D01–D09, LD01–LD05 and all nine P0 Bun workflows remain
unchanged. All output explicitly retains `installedNativeAcceptance:false`,
`fullP1Qualified:false`, and `fullParityQualified:false`.

## Real-evidence negative controls

```sh
python3 -B crates/hrc-store/e2e/evidence/controls.py /absolute/retained-batch \
  --identity /absolute/independent-identity.json \
  --out /absolute/owned-artifacts/NEW-controls-directory
```

The output must be new. Controls copy actual evidence, never synthesize success
or mutate an original or SQLite database. Each target assertion must PASS in the
baseline before its corruption may count as rejected. Copies remove a required
field/command/boundary, empty both result arrays, reverse order, remove all
persisted effects, change a stored-row snapshot, replace native identity, truncate
JSON, or change mail cardinality. Expanded controls also substitute captured source,
reorder committed observer and FTS results, leak a caught invalid part effect,
and leak an aborted roster claim. Each copy gets a freshly regenerated coherent
manifest. Exact per-assertion reasons, baseline and full mutated revalidations are
retained. Each regenerated manifest must also PASS independently. Overall GAP/FAIL alone
is insufficient evidence that a control worked.

Invocation controls additionally require a passing real baseline and reject a
coherently relinked wrong scenario, an actual nonzero command exit, and a missing
stdout field. Run `invocation_controls.py --root ROOT --identity PIN --out NEW`
for the retained baseline and per-target reasons. They regenerate manifests and
check manifest validity separately from rejection.
