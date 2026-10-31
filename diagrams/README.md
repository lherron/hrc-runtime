# hrc-runtime diagrams

Arris natives (`*.arris.json`) are the editable sources; `*.declaration.json` is the starter input that made each one and is not re-run. Rendered PNGs sit in `seat-data.board-preview/`. `*.preview/` bundles are build output and are not tracked.

Open the board live: `arris serve diagrams/seat-data.arris-board.json --gui`.

## seat-data board (2026-10-31, proposal, not approved)

Three frames on where seat session data lives and where it should live. Context: c2 cards sit in Loggia's `storage.json` on max3 (c2 `docs/card-contract.md` §3); Lance asked whether HRC has a proper home for seat data that fits the cardo model.

| frame | claim |
| --- | --- |
| `seat-data-as-is` | Seat data lives in three stores (HRC's `state.sqlite`, Loggia plugin storage, wrkq's hcs binding) and the kernel flattens a seat to one row: `hrc.seat` = latest generation ⊕ runtime ⊕ attention, no hierarchies. |
| `seat-data-to-be` | HRC owns every seat fact. A new `seat_documents` table (JSON ≤ 64 KB per generation · ns · id, `put` fenced on `attention.at`) joins `session_metadata` (scalars) and the ledger (time series). Card clicks become `seat.document.action` ledger events. The kernel mirrors all of it; Loggia plugins keep only UI preferences. |
| `seat-data-document` | The `hrc:hrc` document becomes a lineage hierarchy: `hrc.project › hrc.seat › hrc.generation › hrc.runtime`, with `hrc.document` nodes under their generation. Attention is a payload field on the generation. The document stays rebuildable and observation-only; every node mirrors one store row (cardo semantics §2.10–2.12). |

Facts the frames rest on (verified 2026-10-31 on max3):

- `turn.attention` is an `hrc_events` row appended by `hrc-turn-attention` through the only accepting route (`crates/hrc-native/src/server/turns/attention.rs`); `seat.attention` is a pure projection of the selected display event (`crates/hrc-domain/src/projection.rs`), contract `architecture/contracts/turn-attention.yaml`.
- `session_metadata` is continuity-scoped `(scope_ref, lane_ref, key, source)`, scalars or arrays of scalars, ≤ 4 KB, 64 keys (`crates`/`packages/hrc-core/src/session-metadata.ts`).
- The kernel document is declared in `crates/hrc-domain/src/declarations.rs`: three flat root observation types, no hierarchies or reference fields.
- Loggia plugin storage holding seat state: c2 `cards`, `actions`, `inflight`; session-switcher `attention.asks`.
