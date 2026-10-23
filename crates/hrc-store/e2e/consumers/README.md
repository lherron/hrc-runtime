# Unchanged Bun consumers of native scratch state

This standalone external adapter exercises C01–C07 using a caller-supplied frozen
`rusthrc` executable and the qualified immutable Bun release. It never builds,
installs, restarts shared services, dispatches agents, or writes Rust source.
`harness.py` provisions NEW scratch databases through the existing canonical Bun
oracle, waits for native scenario processes to exit, then invokes the unchanged
installed CLI/scripts. C04 provisions a separate disposable wrkqd and Bun
foreground owner in real Ghostty terminals, with fresh credentials and roots.

Run from the allocated parity worktree, using the parent's frozen executable:

```sh
python3 -B crates/hrc-store/e2e/consumers/harness.py \
  --native /absolute/artifacts/rusthrc-consumer-217 \
  --native-sha256 HASH_FROM_PARENT \
  --native-origin 'parent frozen build217, source checkpoint and dirty paths' \
  --release /Users/lherron/.bun/install/hrc-runtime-releases/release-20261023084446986-41220 \
  --scratch-root /tmp/hrcp1-consumers-UNIQUE \
  --out /absolute/durable/artifacts/UNIQUE
python3 -B crates/hrc-store/e2e/consumers/validate.py /absolute/durable/artifacts/UNIQUE
```

Both root and output must be new. Artifacts must be outside scratch. The Bun
release ID and full source commit are checked; drift is refused. All actual
executable/module paths and hashes, commands, exits, stdout/stderr, selected safe
environment paths, real row snapshots, SQLite backups and cleanup are retained.
The native artifact must be a native executable; it is hashed before/after every
native leg. Parent build artifacts may be copied and frozen outside the checkout.
No new Cargo target is created.

`--cases C02` runs an explicitly labeled subset. `validate.py --allow-subset`
accepts such an artifact only at subset scope. `validate.py` normally requires all
seven cases and every fixed assertion from `requirements.py`; it reparses raw
stdout, checks semantic rows/results, and verifies the artifact manifest. Missing
commands/cases/fields, malformed output, empty rows, partial tool completion,
missing native scenarios and unavailable infrastructure cannot produce a pass.
The initial summary stays incomplete across interruption. Normal nonpassing runs
save failures and clean their scratch. Failed owned-process shutdown retains
scratch and reports `INFRA_ERROR` for operator cleanup.

The parent P0 adapter can invoke this CLI as a child, retain its exact exit and
JSON stdout, and call `validate.validate(output)` after exit. Compare stdout with
`summary.json` including `exitCode`. Do not route this through P0's Bun-turn suite,
substitute a status fixture, or turn result flags into native API evidence. This
adapter does not modify P0 profiles, inventory, assertion law or aggregation.

## Cases and controls

| Case | Actual behavior |
| --- | --- |
| C01 | Native run/operation/invocation/raw/lifecycle/artifact seed; exact/runtime/host exports; complete run fields and optional presence; nonempty per-run MIN/MAX versus unrelated global head; absent/invalid/zero-event controls. |
| C02 | Native-created `p1-app`; installed written/reordered unchanged/conflict exit1 with unchanged full row/replaced document; all supported fields; native typed reload; invalid JSON/object/key/type/empty/absent controls. Usage errors are retained at their actual exit2. |
| C03 | Exact-scope nonempty candidate and full mirror counts; auto provider artifact versus explicit JSONL; missing all/one mirror, divergent mirror, failed projection, hole, missing lifecycle/invocation, wrong/unreadable artifact, duplicate/wrong lifecycle controls. Warning/inconclusive exit0 semantics are preserved while the independent positive oracle rejects them. |
| C04 | Fresh private wrkqd/token/catalog/bootstrap; private ASP/project/peers/ingest/publication destinations; real P0 isolation admission and ASP resolution; native exits before unchanged Bun foreground starts; real socket/CLI status exact DB; nonempty monitor host identity/highwater; stop/cleanup then native reopen. Startup mutations are recorded. No runtime births. |
| C05 | Real spill/restub/strip/default runtime-buffer retention with explicit DB/runtime root; dry/apply/repeat; both ledger counts/bytes/blobs/hydration; exact skipped/preserved controls; real busy writer; committed-state kill/resume for each family and concurrent native append. Historical SQL setup is separately labeled and advances the canonical shared stream allocator. |
| C06 | Same-DB `events_legacy`, explicit `HRC_DB_PATH`; full-row copy/delete/repeat; broker/tmux preservation; deletion-before-copy refusal; wrong payload at same seq rejected externally despite source acceptance; observed partial copy/delete kill/resume; native typed remaining rows and preserved allocated highwater. |
| C07 | Native active/retired node ledgers; separate rebuilt registry; unique active/same-home duplicates; other-home refusal on independently initialized source; existing-output exit2/no overwrite; missing-input refusal; native and Bun output reads; all source tables/schema/sequence logically unchanged. |

`control_checks.py` rejects inadequate assertion inputs before producer runs.
`evidence_controls.py EVIDENCE --out NEW_DIR` tampers coherent actual artifacts
(removes a case/assertion/command, truncates raw JSON, erases native rows, marks
incomplete) and requires the external validator to refuse every variant. These
are checker controls, never product qualification.

## Native scenario interface

All commands take explicit `--db SCRATCH/state/state.sqlite` after canonical
`../oracle.ts RELEASE SCRATCH/state seed` has exited. Fixed scenarios are owned
by the parent; missing scenarios remain `GAP`.

- `execution-contract` creates `p1-app`; `consumer-reload` returns typed `run` and exact `correlationJson`.
- `consumer-history-contract` returns run/runtime/host/invocation/scope/artifact identities, exact `expectedLifecycle`, and real typed readback. `consumer-history-read` reads those persisted records.
- `consumer-placement-active` and `consumer-placement-conflict` create the same active/retired canonical scopes at distinct fixed homes on separate canonical-initialized ledgers. `consumer-registry-read --registry NEW_OUTPUT` returns typed bindings.
- `consumer-archive-history` creates legacy/broker/legacy/tmux raw rows; `consumer-archive-read` returns typed remaining `events` and allocated `streamHighWater`.
- `consumer-maintenance-read` returns fixed keyed cases for shared/different results, valid/missing/incomplete/mismatch/invalid stubs, payload/null/stripped envelopes and old/recent/live-run/live-runtime/active-run buffers. Each contains typed `brokerEvents`, `lifecycle`, `buffers`.
- `consumer-append-control` appends a real unrelated lifecycle row and returns `{row}`.

C04 requires installed `ghostmux`, `wrkqadm`, `wrkqd`, `wrkq`, and a reachable
real ASP daemon (`--asp-socket` overrides its explicit default). Provisioning uses
fresh authority ports/credentials rather than reusing P0's cleaned subjects. The
optional `--monitor-profile` is for an externally prepared dedicated subject
within this run's scratch root; it must pass the same P0 admission and contain no
HRC DB or existing owner/socket. It is not a source of fabricated responses.

Every current run is **source-native with installed-Bun consumers**. Even a full
source consumer PASS has `installedNativeAcceptance=false`,
`fullP1Qualified=false`, `fullParityQualified=false`. Canonical landing,
installed-native acceptance, P0 aggregation, all 418 operation/81 direct-SQL
mapping closure and Astra's independent grade remain with the parent. D01–D09
and LD01–LD05 remain held/nonpassing. No destructive held ledger operation is
implemented here.
