# hrc-runtime diagrams

Arris natives (`*.arris.json`) are the editable sources; `*.declaration.json` is the starter input that made each one and is not re-run. Rendered PNGs sit in `seat-data.board-preview/`. `*.preview/` bundles are build output and are not tracked.

Open the board live: `arris serve diagrams/seat-data.arris-board.json --gui`.

## seat-data board (2026-10-31, proposal, not approved)

Three frames on where seat session data lives and where it should live. Context: c2 cards sit in Loggia's `storage.json` on max3 (c2 `docs/card-contract.md` §3); Lance asked whether HRC has a proper home for seat data that fits the cardo model.

| frame | claim |
| --- | --- |
| `seat-data-as-is` | Seat data lives in three stores (HRC's `state.sqlite`, Loggia plugin storage, wrkq's hcs binding) and the kernel flattens a seat to one row: `hrc.seat` = latest generation ⊕ runtime ⊕ attention, no hierarchies. |
| `seat-data-to-be` | HRC owns every seat fact. A new `seat_annotations` table (JSON ≤ 64 KB per subject · ns · kind · id, `put` fenced on `attention.at`) joins `session_metadata` (scalars) and the ledger (time series). Card clicks become `seat.annotation.action` ledger events. The kernel mirrors all of it; Loggia plugins keep only UI preferences. |
| `seat-data-document` | The `hrc:hrc` document becomes a lineage hierarchy: `hrc.project › hrc.seat › hrc.generation › hrc.runtime`, with `hrc.annotation` nodes under their seat or generation. Attention is a payload field on the generation. The document stays rebuildable and observation-only; every node mirrors one store row (cardo semantics §2.10–2.12). |
| `seat-data-model` | The same document instanced with real seats (2026-10-31): nesting is the lineage hierarchy, each node a record card, store rows and the ledger beside it. Built by a composed-figure script, not the scenario starter; the native is the source. |

### Annotation: the generic seat record

"Card" is c2's rendering, not the HRC concept. The HRC concept is an **annotation**, in the Kubernetes sense: a namespaced, kinded, opaque JSON record a third party attaches to an object it does not own, beside `session_metadata` as the scalar "labels". Shape: `{subject: seat | generation, ns, kind, id, body, fence?, updatedAt, updatedBy}`. A c2 card is kind `c2.card`; a Vesta ask is `c2.ask`.

Extensibility, checked per axis a new kind would stress:

- **new kind** — no HRC change: the writer owns the body schema; Loggia filters `where {ns, kind}` on `hrc.annotation` rows. A kind that wants declared fields and hints can later get its own node type; that is an upgrade, not a requirement.
- **subject** — a seat (continuity-scoped: survives rotation; an hcs binding, a pinned note) or a generation (rides with its node; superseded on rotation).
- **fence** — generic `expect {generation?, attentionAt?}` → `stale_annotation`; not card-specific.
- **size** — ≤ 64 KB inline; larger payloads (c2 `detailHtml`, 512 KB) reference HRC's blob store.
- **time series** — never an annotation: actions and classifications are ledger events (cardo §2.11).

Facts the frames rest on (verified 2026-10-31 on max3):

- `turn.attention` is an `hrc_events` row appended by `hrc-turn-attention` through the only accepting route (`crates/hrc-native/src/server/turns/attention.rs`); `seat.attention` is a pure projection of the selected display event (`crates/hrc-domain/src/projection.rs`), contract `architecture/contracts/turn-attention.yaml`.
- `session_metadata` is continuity-scoped `(scope_ref, lane_ref, key, source)`, scalars or arrays of scalars, ≤ 4 KB, 64 keys (`crates`/`packages/hrc-core/src/session-metadata.ts`).
- The kernel document is declared in `crates/hrc-domain/src/declarations.rs`: three flat root observation types, no hierarchies or reference fields.
- Loggia plugin storage holding seat state: c2 `cards`, `actions`, `inflight`; session-switcher `attention.asks`.
