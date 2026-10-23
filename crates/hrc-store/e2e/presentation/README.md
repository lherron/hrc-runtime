# Stored presentation qualification

This bounded P1 seam implements actual `presentation-read-model.ts` keyed reads
and stored projection. It has no HTTP server, execution owner, process probe,
recovery, migration, or installed-native acceptance claim. Native observations
use the parent-frozen executable. The oracle imports unchanged qualified Bun
`handleReadPresentationSeats` and `projectPresentationRuntime`, and passes actual
Requests against canonical scratch repository fixtures. Fixture subprocesses exit
before every reader. Native read calls share a ReadTx snapshot; Bun readers enable
query_only. Full runtime enumeration remains separate from keyed reads.

Run `python3 -B crates/hrc-store/e2e/presentation/presentation_e2e.py --identity
/absolute/parent-frozen/identity.json --artifacts /absolute/new/evidence-directory`.
No build/install/service action is performed. The independently supplied identity
must pin the native path/hash/source tree and immutable Bun release/source commit.
Parent owns module/driver integration, builds, freezes, staging, commit and push.

`presentation-contract` returns the real complete paired `full`, `empty`,
`runtimeOnly`, `alias`, `missing`, `projected`, `invalid` observations.
`presentation-chunks-contract` uses four bounded calls in one snapshot (three
128-key slices, then runtime IDs), retaining actual inputs and merged rows.
Original ref spellings remain Map keys; parsed refs are not over-normalized.
Runtime IDs follow session refs, dedupe in insertion order and name unavailable
seats. Output rows replace without moving their first insertion position.

Assertions (raw stdout JSON paths, with complete rows/order compared):

- `presentation/initial`: full sessions include every bulk0..269 identity, quiet
  awaiting-input, recent older generation, exact recency boundary, latest fallback
  generation3, active-run terminal, and lane alias. Excludes cold terminal outside.
  Runtime IDs and selected lifecycle session/generation/latest sequence are exact.
- `presentation/chunks`: Bun `chunks-bun.json` parsed stdout `/result/{inputs,value}`;
  native `chunks-native.json` parsed stdout `/{inputs,value}`;
  every call <=128 keys; complete merged value equals unbounded real source result.
- `presentation/projection`: initial projected rows cover title source precedence,
  optional identity, metadata, null/absent presentation, stored context including
  lone UTF16 surrogate, normalized attachable and explicitly unattachable hosting,
  tmux override precedence, flat observer fallback, and ordered filtered surfaces.
- `presentation/refusal`: initial invalid entries preserve malformed_request and
  exact source messages for omitted arrays/nonstring/empty keys and malformed refs.
- `presentation/context-null`, `/hosting-malformed`, `/activity-recency`,
  `/metadata-cleared`, `/latest-absent`: independently modified scratch controls,
  full actual Bun/native values compared; no arbitrary value/clock omission.
- `presentation/passivity`: each command has full coherent schema/table/sequence
  logical snapshots before AND after. `updateActivity-control` is the actual
  canonical Bun mutation and must fail that same logical equality checker.
- `presentation/negative`: eleven retained altered observations must fail both
  exact parity and independent selection discriminators, including >256 truncation,
  dropped rows, order/lane/generation/context/identity, absence and both-empty.

Native stdout is the direct result object; Bun observe/chunks stdout wraps it in
`result`. Each anchor records a receipt and explicit `stdoutJsonPointer`, applied
after parsing that receipt's raw stdout string. Empty pointer denotes native root.

Per-child capture.json/commands contain actual argv/status/stdout/stderr/PID/time,
executable and before/after hashes. Source copies/hashes and coherent SQLite
backups are retained, with complete SHA256SUMS. `summary.json` is navigation only,
not evidence. Parent evidence seat must explicitly add reconstruction/aggregation
for this family; the older fixed45 catalog does not cover it automatically.

Mapping: direct SQL presentation-read-model.ts recency query is now typed
PresentationQueries::read_seats; existing SessionRepository.listByScopeRef,
RuntimeRepository.{getByRuntimeId,listByScopeRef}, HrcLifecycleEventRepository.
findLatestBySession, SessionTitleRepository.getByHostSessionId,
SessionMetadataRepository.get and SurfaceBindingRepository.findByRuntime are
composed in the same snapshot. No all418, full P1 or P0 workflow closure is claimed.
D01-D09/LD01-LD05 and nine P0 workflows are unchanged.

Current shared identifier domain uses Rust Unicode String for refs/IDs; the
body decoder explicitly refuses non-Unicode identifiers instead of silently
replacing UTF16. Opaque payload/title/tmux/context strings use lossless JsValue /
JsString, including explicit null. This boundary is disclosed for parent review.
