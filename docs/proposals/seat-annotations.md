# Seat annotations and the kernel seat lineage

Status: r1.1, 2026-10-31, draft for Daedalus review (T-12183); r1.1 takes four readback points from mable@hrc-runtime (EN-39517): no retention delete, Gate 2 without a clock seam, one attention function, delete as POST. Owner mable@c2:primary. Diagrams: `diagrams/seat-data.arris-board.json` (frames `seat-data-as-is`, `seat-data-to-be`, `seat-data-document`, `seat-data-model`). Rulings by Lance on 2026-10-31 are marked **RULED**.

## 0. Claim

HRC owns every seat fact. Data that a third party attaches to a seat or to one of its generations (today: c2 cards and Vesta asks, kept in Loggia's `storage.json` on max3) becomes an **annotation**: a namespaced, kinded, opaque JSON record in HRC's store, written through HRC's API, fenced by HRC against the seat's live state, and mirrored by the hrc kernel document like every other seat fact. The kernel document gains `hrc.generation` and `hrc.annotation` nodes beside `hrc.seat` and `hrc.runtime`, so a consumer reads the lineage seat › generation › runtime | annotation from one mount instead of re-deriving it.

**RULED (Lance, 2026-10-31):** card storage is part of HRC seat session data. The name "card" is c2's rendering, not the HRC concept; the HRC concept is the annotation (naming delegated to mable). The 64 KB body limit stays.

## 1. Today, verified 2026-10-31 on max3

- The seat concept is sound in `state.sqlite`: `continuities(scope_ref, lane_ref) → active_host_session_id`; `sessions`, one row per generation (`host_session_id` identifies a generation; `rotate` archives it and creates generation+1); `runtimes`, the process per generation; `session_metadata`, continuity-scoped scalars (≤ 4 KB, 64 keys, sources `launch | hrc | api`, `crates/hrc-store/src/metadata.rs`), whose writes append `session.metadata.changed` to the ledger.
- `turn.attention` is a ledger row appended by `hrc-turn-attention` through the only accepting route (`crates/hrc-native/src/server/turns/attention.rs`); `seat.attention` is a pure fold of the selected display event (`crates/hrc-domain/src/projection.rs`, contract `architecture/contracts/turn-attention.yaml`).
- The kernel document (`crates/hrc-domain/src/declarations.rs`) has three flat root observation types: `hrc.seat` (latest generation ⊕ its runtime ⊕ attention), `hrc.runtime`, `hrc.project`. No hierarchies, no reference fields. Loggia consumers read the folded fields off the seat row: `seat.runtimeId` (9 sites), `seat.hostSessionId` (8), `seat.generation` (13), `seat.attention` (6), `seat.tmux` (4), `seat.hrcpty` (3) across session-switcher, ui-concierge, session-inspector and c2.
- Seat-attached state outside HRC: c2 plugin storage `cards`, `actions`, `inflight` (20 cards, 0.9–1.8 KB each; `c2/docs/card-contract.md` §3, §7); session-switcher `attention.asks`. The defect class this invites: a Loggia remount read a missing row as "the seat moved" and superseded two open cards (R-00570, fixed in c2 a1ccc2c).
- Federation already routes `GET|PATCH /v1/sessions/metadata` to the scope's home node (`server/placement/federation/routing.rs:62`, `peer_listener.rs:21`).
- Bun owns the schema: Rust refuses a store whose `hrc_migrations` set differs from `MIGRATIONS` (`crates/hrc-store/src/lib.rs::assert_schema`). A new table is a Bun migration plus the Rust constant.
- cardo `upsert` places a node by natural key and leaves it a root in every hierarchy (`cardo-core/src/doms.rs::upsert`, `put`). There is no keyed-parent placement, so a projector that writes by key cannot declare a hierarchy today.

## 2. Decisions

| id | decision | why |
|---|---|---|
| D1 | **Name: annotation.** Table `seat_annotations`, node type `hrc.annotation`, routes `/v1/sessions/annotations`, ops `seat.annotation.put` / `seat.annotation.act`, CLI `hrc session annotation`. | "Document" collides with cardo's document. An annotation in the Kubernetes sense is exactly this: namespaced, kinded, opaque, owned by its writer, attached to an object it does not own; `session_metadata` is the scalar "labels" beside it. |
| D2 | **HRC never interprets the body.** `{ns, kind, id}` is the key; `body` is any JSON object the writer's namespace owns. A new kind needs no HRC change. | Extensibility along the one axis Lance named (more semantic data like cards). A kind that later wants declared fields and renderer hints gets its own node type then; that is an upgrade, not the entry price. |
| D3 | **Subject is a seat or a generation.** Seat-scoped annotations survive rotation (an hcs binding, a pinned note); generation-scoped ones ride with their generation and are superseded by rotation (a card about one attention event). | The first draft allowed only generations and would have had no home for continuity-scoped data. |
| D4 | **Body ≤ 65,536 bytes serialized; ≤ 256 annotations per subject.** One constant each, in `hrc-store`. Larger content is referenced (a path or URL in the body, as c2 evidence images are today), never inlined. | Not a storage limit. An annotation is projected into every subscriber's document: every Loggia resync carries every live one, every upsert goes through the 32 MB / 4096-event ring. One writer's fat body degrades every reader, silently. The cap fails loudly at write time instead. 64 KB is 40× today's largest card and ~500 upserts per ring wrap. |
| D5 | **Relations by key in v1; the `lineage` hierarchy is declared later, additively.** `hrc.generation.sessionRef` → seat, `hrc.runtime.hostSessionId` → generation, `hrc.annotation.{sessionRef, hostSessionId}` → seat or generation. | cardo's keyed `upsert` cannot place a node under a parent (§1). The hierarchy needs a cardo change (keyed-parent upsert), filed as a cardo task after this review; when it lands, `lineage` is declared with no payload change and Loggia's `where` queries keep working. |
| D6 | **Time series stay in the ledger.** Writes append `session.annotation.changed`; clicks append `session.annotation.action`. No body history. | cardo §2.11: doms holds the current situation, never a ledger. c2's acceptance rate is a ledger query, cursor-able and federated. |
| D7 | **`hrc.seat` keeps every folded field.** `runtimeId`, `tmux`, `hrcpty`, `attention`, `latestEvent`, `contextReading`, `metadata` stay on the seat row as today; `hrc.generation` carries `attention` and `latestEvent` too. | Nothing in Loggia changes to adopt this; deprecating the folded fields is a later task with its own consumer migration. The attach surface stays on `hrc.seat` for the same reason. |
| D8 | **No migration of existing cards.** The Loggia map drains under its 7-day prune; new attentions go to HRC; Vesta re-puts her open asks once. | Cards are ephemera. |
| D9 | **Rust serves the routes; Bun ships the migration, SDK and CLI only.** | The execution owner on every kernel node is rusthrc (`hrc-rust-migration.md` §8.1); a Bun-owned node has no kernel and no Loggia mount, so annotation routes there would have no consumer. Explicitly unsupported (§8). |

## 3. Store

Bun migration `seat-annotations` (`packages/hrc-store-sqlite/src/migrations/`), id added to `MIGRATIONS` in `crates/hrc-store/src/lib.rs` in the same commit:

```sql
CREATE TABLE seat_annotations (
  scope_ref       TEXT NOT NULL,
  lane_ref        TEXT NOT NULL,
  subject         TEXT NOT NULL CHECK (subject IN ('seat','generation')),
  host_session_id TEXT NOT NULL DEFAULT '',   -- '' for subject=seat; the generation's session otherwise
  generation      INTEGER,                    -- NULL for subject=seat
  ns              TEXT NOT NULL,
  kind            TEXT NOT NULL,
  id              TEXT NOT NULL,
  body_json       TEXT NOT NULL,
  fence_json      TEXT,                       -- the expect that admitted the last put, for readback
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  PRIMARY KEY (scope_ref, lane_ref, host_session_id, ns, kind, id)
);
CREATE INDEX seat_annotations_by_session ON seat_annotations (host_session_id, updated_at);
```

Validation (`crates/hrc-store/src/annotations.rs`, before the transaction, same style as `metadata.rs`):

- `ns`, `kind`: the metadata key grammar (1–4 lowercase alphanumeric segments, ≤ 64 chars each, ≤ 128 bytes). `id`: 1–200 bytes, no control characters.
- `body`: a JSON object; serialized ≤ 65,536 bytes → else `annotation_invalid` with the reason.
- `subject = generation` requires a `sessions` row for `(scope_ref, lane_ref, generation)` → else `unknown_generation`; `subject = seat` requires the continuity → else `unknown_host_session` (as metadata).
- A put that would make a subject's 257th annotation → `annotation_quota`.
- **Fences**, all optional, all checked in the write transaction:
  - `expect.generation`: must equal the continuity's active generation → else `stale_generation`.
  - `expect.attentionAt`: must equal the live attention `at` of the active generation → else `stale_attention`. Live attention is one function in `hrc-store`, `live_attention(host_session_id, generation)`, that owns **both** the display-event selection (today the projector's `turns` slice: the latest turn-family event at or below the generation's latest raw event) **and** the fold (lit `turn.attention` or `turn.awaiting_input` → its `ts`; anything else → none). The projector consumes that function instead of `projection.rs::attention`, so the fence and the `hrc.seat` row c2 reads can never disagree (`hrc-domain → hrc-store` is an existing edge).
  - `expect.updatedAt`: must equal the row's `updated_at` (absent row: must be absent) → else `stale_annotation`. This is the optimistic lock two Loggia windows need so only one moves a card to `sent`; it replaces c2's `inflight`.
- Every admitted put or delete appends `session.annotation.changed {scopeRef, laneRef, subject, generation, ns, kind, id, op: put|delete, updatedBy}` through `append_session_event`, which is what wakes the kernel's ledger watch. The body is not in the event.
- Retention: none. Rows of both subjects live until deleted. Nothing in the daemon deletes session-family rows today (`sweeps.rs` archives, never deletes), rows are 1–2 KB, and generation-scoped ones already leave the *document* through `live_until`; a second lifecycle is not worth its clock test until a table size says so (§8).

## 4. API, federation, SDK, CLI

Routes in `hrc-native` (`server/projection/sessions.rs` beside metadata):

| route | body / query | answer | refusals |
|---|---|---|---|
| `GET /v1/sessions/annotations` | `scopeRef, laneRef?, subject?, generation?, ns?, kind?` | `{annotations: [row…]}` | `unknown_host_session` |
| `PUT /v1/sessions/annotations` | `{scopeRef, laneRef?, subject, generation?, ns, kind, id, body, expect?}` | `{annotation: row, created: bool}` | §3 |
| `POST /v1/sessions/annotations/delete` | `{scopeRef, laneRef?, subject, generation?, ns, kind, id, expect?: {updatedAt}}` | `{deleted: bool}` | `stale_annotation` |
| `POST /v1/sessions/annotations/act` | `{scopeRef, laneRef?, subject, generation?, ns, kind, id, action, attributes?}` | `{hrcSeq}` | `unknown_annotation` |

Delete is a POST, not an HTTP DELETE, because it carries a body through the federation forwarder like `act` does. `act` appends `session.annotation.action {…key, action, attributes}` and writes nothing else; `attributes` is writer-owned (c2: `{recommended, edited, ok, runId?, error?}`). `updated_by` is the request principal, as metadata records `updatedBy`.

Federation: the four method/path pairs join `routing.rs` (scoped by `scopeRef`; `principal: true` on the three writes, as `PATCH /v1/sessions/metadata`) and the peer listener's allowlist, so a put from any node lands in the home node's store and the home node's ledger.

SDK (`hrc-sdk`): `listSessionAnnotations`, `putSessionAnnotation`, `deleteSessionAnnotation`, `actOnSessionAnnotation`. CLI: `hrc session annotation list|put|delete|act <target> --ns NS --kind KIND --id ID [--subject seat|generation] [--generation N] [--body-file -] [--expect-generation N] [--expect-attention-at TS] [--expect-updated-at TS] [--action A] [--attributes JSON]`, same target grammar as `session meta`.

## 5. Kernel

Declarations (`crates/hrc-domain/src/declarations.rs`), all `family: hrc.observation`, all `observation: true`, document still rebuildable:

- `hrc.generation` — natural key `[hostSessionId]`; payload `sessionRef, scopeRef, laneRef, hostSessionId, generation, status (active | archived), createdAt, lastActivityAt, latestEvent, attention`; `live_until`: null while a runtime of that generation is live, else `lastActivityAt + 24 h` (the seat rule, per generation). The projector's reader returns every generation of a continuity with activity inside the window, not only the latest (`sessions_for_projection` gains the archived rows; `project_with_context` stops collapsing to the max generation for this type while still selecting the max for `hrc.seat`).
- `hrc.annotation` — natural key `[sessionRef, hostSessionId, ns, kind, id]`; payload `sessionRef, scopeRef, laneRef, subject, hostSessionId, generation, ns, kind, id, body (json), fence (json), createdAt, updatedAt, updatedBy`; `live_until`: seat-scoped follows the seat row; generation-scoped follows its generation. Removal is `remove_by_key` when the subject drops out or the row is deleted. `hints: {title_field: "id", summary_fields: ["ns", "kind", "updatedAt"]}`.
- `hrc.seat` — unchanged fields (D7) plus `activeGeneration` (integer, equals `generation`).
- `hrc.runtime`, `hrc.project` — unchanged.

Ingest: the projector reads `seat_annotations` on its own read-only connection in the same read transaction as sessions and runtimes; `session.annotation.changed` is an ordinary ledger write, so the existing wake covers it. Cargo tests extend `every_projected_seat_field_is_declared_including_attention` to the two new types.

Ops (bindings over in-process dispatch, as `seat.send`): `seat.annotation.put {session_ref, subject, generation?, ns, kind, id, body, expect?}` → `{updated_at, created}` and `seat.annotation.act {session_ref, subject, generation?, ns, kind, id, action, attributes?}` → `{hrc_seq}`. Fences are HRC's (`expect`), not cardo's: the generation node's revision changes on every activity, so a cardo node fence would be stale constantly and says nothing about attention. Declared `fences: "none", effect: "write"`, no cardo idempotency (put is idempotent by key).

## 6. Consumers

**c2** (its own c2 task, graded there, after this lands): `plugin.js` drops `cards`, `actions`, `inflight`; classifier cards become `seat.annotation.put` with `ns: c2, kind: card, subject: generation, expect: {attentionAt}`; Vesta's `card.put` becomes `hrc session annotation put --ns c2 --kind card` from any node, `card.retire` a put with `state: retired`; Vesta asks are `kind: ask` on her own generation; supersede/resolve on attention move stay plugin logic and write back with `expect.updatedAt`; clicks call `seat.annotation.act`; the pane queries `hrc.annotation where {ns: "c2"}`. `scope.allow` and `wake.*` stay in plugin storage; they are the host's.

**Other Loggia plugins:** no change required (D7). session-switcher's `attention.asks` consumed-marker is host-local by meaning and stays.

**hcs:** `hcs bind` is a candidate seat-scoped kind (`wrkq.hcs`); not in this task.

## 7. Gates (product claims, graded from durable readback)

1. **Round trip on a scratch daemon.** `hrc session annotation put` then `list` returns the body; a second put with the stale `--expect-updated-at` refuses `stale_annotation`; a 65,537-byte body refuses `annotation_invalid`; after a real turn moves the seat's attention, a put with the old `--expect-attention-at` refuses `stale_attention`. Readback: the CLI e2e artifacts and the ledger's `session.annotation.changed` rows.
2. **The kernel shows it.** `loggia query hrc:hrc --type hrc.annotation` (or `kq.py`) shows the put within one ingest wake; `hrc session rotate` the seat: the annotation stays under its now-archived `hrc.generation` node and the new generation has none. Readback: query output with revisions. The 24 h expiry of an archived generation and its annotations is a cargo test at the projector unit with an injected `now` (`project()` already takes one); eviction on `live_until` is the kernel's existing behaviour, and no daemon-level clock seam is built.
3. **Federated write.** From svc, put an annotation on a max3-homed seat; it is in max3's `seat_annotations` and in max3's kernel. Readback: `sqlite3` row on max3 and `loggia query` on max3.
4. **Nothing else moved.** On the installed max3 build, session-switcher, ui-concierge and session-inspector guards (`loggia/scripts/*-guard.py`) are green; `hrc.seat` rows carry every field they carried before plus `activeGeneration`. Readback: guard output and a `loggia query --type hrc.seat` diff against the pre-install capture.
5. **The motivating defect class is closed** (c2 task): a real blocker card written through HRC, acted on from the pane, the action in the ledger, then `loggia mount rm/add hrc` — the card is still open. Readback: ledger rows, `cards.list`, screenshots.

## 8. Explicitly unsupported

- Annotation routes on a Bun-owned node (D9); max3 is forward-fix only.
- Kernel rows for other nodes' seats and remote attach (unchanged from the kernel contract).
- The `lineage` hierarchy declaration in this task (D5; cardo keyed-parent upsert first).
- Bodies over 64 KB, body schema validation by HRC, per-kind configuration, per-kind retention.
- Annotation body history. The ledger records that a key changed and who changed it, not what it said.
- Retention or deletion by age. Rows live until deleted; a prune lands the day a table size asks for one.
- Migrating existing Loggia cards (D8).
- Removing the folded fields from `hrc.seat` (D7; a later task).
- Feature flags.

## 9. Follow-ups filed after approval

- cardo: keyed-parent placement for `upsert` (`hierarchies: {name: {parent: {type, key}}}`), so an ingest projector can declare `lineage` without ids.
- c2: adopt annotations (§6), including the one-time re-put of open Vesta asks.
- hrc-runtime: deprecate the folded `hrc.seat` fields once every Loggia consumer reads `hrc.runtime` and `hrc.generation`.
