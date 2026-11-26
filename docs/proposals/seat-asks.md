# Seat asks: a seat's open questions as one HRC seat record

Revision 1.6, 2026-11-25 (T-14574). The live reader is `prae ext` over
`seat.ext`. Daedalus approved the v1 contract in EN-40752, recorded as
[seat-asks.yaml](../../architecture/contracts/seat-asks.yaml). Revision 1.5
added the optional seat-owned `problem` field. The HRC annotation body
remains opaque.

## 0. Claim

A seat's open questions for its human are **one seat-scoped HRC record**, `hrc.asks`, holding one row per question. The seat writes it, a reviewer may annotate rows, a deliverer stamps rows as sent, and any client (Loggia c2 pane, hrc-ios, taskboard, a CLI) reads and answers rows from it without knowing which workflow produced them. A status turn writes nothing. The record survives generation rotation because it holds the question, not the conversation.

**RULED (Lance):** c2 is Lance's own question-answering workflow; a seat's open questions are a generic capability. The record is therefore namespaced `hrc`, not `c2`, and its schema is documented by hrc-runtime (this file). c2's own bookkeeping (`config`, `ping`, `receipt`) stays `ns: c2`.

## 1. Today, verified 2026-11-01 on max3

- `seat_annotations` holds 162 live rows, all `ns: c2`: `card` 144 (generation-scoped, keyed by `attention.at`), `ask` 4, `receipt` 13, `config` 1 (the only seat-scoped row). HRC names no kind of its own; the annotation facility is purely third-party today (`architecture/contracts/seat-annotations.yaml`).
- A card is written per attention event and attention is per turn: mable@c2:primary gen 3 lit six attention events on one question in 14 minutes (13:46:47 → 14:00:25); the controller wrote 13 cards in 14 minutes on one generation, each superseded by the next turn. Rotation without a handoff strands the question (T-12224, gen 79→80, 80→81). These are the defects T-12239 removes; the mechanism is in T-12239 and `c2/docs/card-contract.md` rev 4, not here.
- hrc-ios answers seat questions through ACP's c2 routes. The adapter reads the HRC asks record as well as c2's own kinds. See agent-control-plane `packages/acp-server/src/c2/hrc-adapter.ts`.
- HRC validates key grammar and object shape only; any `ns` is admitted. The `expect.updatedAt` fence exists and refuses `stale_annotation`. `session.annotation.changed` is appended on every admitted put and delete.

## 2. Decisions

| id | decision | why |
|---|---|---|
| D1 | **Key:** `{subject: seat, ns: hrc, kind: asks, id: open}`, one per seat continuity. | One record, not one per question or per attention event: the seat edits its whole list atomically under one CAS, and a reader never joins rows across keys. `id: open` leaves room for a later `id` (an archive) without a new kind. |
| D2 | **HRC owns the schema; HRC changes no code.** The row shape in §3 is this contract. Admission, CAS and events are the existing annotation facility. | The `ns` names the schema owner, not the writer. `ns: hrc` is a documentation act under the existing contract; the typed-node upgrade (D6) is deferred until a consumer needs declared fields. |
| D3 | **Writers by contract, not by HRC.** The seat owns rows; a reviewer owns `review` and may set `dependsOn`; a deliverer owns `sent`. HRC enforces none of it: the principal is the self-declared `x-hrc-principal-ref`, so a seat-only rule in HRC would be theater. | Readers show `updatedBy`; a controller treats the record as the seat's when `updatedBy` is the seat's agent principal. |
| D4 | **The seat writes under its own CAS only:** `--expect-updated-at <prev>`. No attention fence, no generation fence, no touch primitive. | The record is about the seat, not a turn; a generation fence would re-create the rotation defect. |
| D5 | **Rows carry no workflow fields.** `review` and `sent` are generic (any reviewer, any deliverer, each named in the sub-object). Workflow-specific data goes in that workflow's own annotation keyed by row id, never in this record. | A phone that knows nothing about Vesta or c2 renders the row completely. |
| D6 | **Typed kernel node later.** v1 projects as a generic `hrc.annotation` (`where {ns: hrc, kind: asks}`); a declared `hrc.asks` node with fields and hints is an additive upgrade. | No consumer needs declared fields yet; declaring them now freezes the row shape before two clients have rendered it. |
| D7 | **Scope: non-task seats of agents opted in by their controller.** Task seats carry no record (their human is their dispatcher, who reads the task room). | Matches T-12239's scope; widening is a separate ruling. |

## 3. Record

```
key:  {subject: "seat", ns: "hrc", kind: "asks", id: "open"}
body: {v: 1, questions: [row, …]}            // ≤ 64 KB serialized (annotation cap)

row:  {
  id:          string,                          // unique within the record; stable across edits
  ask:         string,                          // non-empty; the question, in the seat's words
  options:     [{label: string, text?: string}],// ≥ 1; labels unique within the row; text defaults to label
  recommended?: string,                         // one option label; dropped by readers if it names none
  problem?:    string,                          // one or two plain sentences: what is happening and what is held up (T-12675)
  why?:        string,                          // one sentence: the reason for the recommendation
  task?:       "T-…",                           // the task the question belongs to; readers group by it
  other?:      true,                            // a free-text answer is allowed
  dependsOn?:  "<sessionRef>#<rowId>",          // this row waits on another seat's row; never delivered on its own
  review?:     {by: principal, verdict: "agree"|"disagree", why: string, recommend?: string, at: iso},
  sent?:       {by: principal, runId?: string, at: iso, text: string}   # runId absent when HRC accepted the delivery without a run (controller-independence, T-12239 D7)
}
```

`problem` is the situation and `why` is the reason for the recommendation. A row without `problem` stays valid, because rows written before it must keep rendering.

Row validity (readers apply it; HRC does not): `id` unique, `ask` non-empty, `options` non-empty with unique labels. A reader keeps the valid rows and drops the rest; a record with no valid row reads as empty. The option shape is the T-12235 question shape so an existing `questions[]` renderer renders a row unchanged.

**Lifecycle, per row.** The seat adds a row when a question for its human arises, edits it while it is open, and removes it when answered (by any client) or moot. `sent` is stamped by whoever delivered the answer (`text` is what went to the seat, with the question in it, e.g. `1. Let Stella run the four live sends? — Approve.`); a sent row is shown greyed and leaves when the seat removes it on its next turn. Nobody else removes a seat's row. A row with `dependsOn` is folded under the row it names and is never delivered by itself. Partial answers: answered rows get `sent`, the rest stay open.

**Record-level.** An empty `questions` array is the "no open questions" state. **The seat never deletes the record:** it is created once (on the seat's first question, or as an empty record to answer a backstop ping) and persists until HRC retires it with the seat (`live_until`), so a reader comparing against its `updatedAt` always has a value; an absent record means "never created" and reads as `updatedAt = epoch` (Daedalus F1). `updatedAt` moves only when the seat, a reviewer or a deliverer writes; a turn that changes nothing writes nothing. Rotation changes nothing: the next generation reads its own open rows.

## 4. Operations (existing)

```
hrc session annotation put <seat> --subject seat --ns hrc --kind asks --id open \
    --expect-updated-at <prev> --as <agent principal> --body-file asks.json
hrc session annotation list <seat> --subject seat --ns hrc --kind asks --json   # select the row with id == "open"; its body and updatedAt are the record and the fence (the installed CLI has no `get`)
# no delete: the seat empties the record (questions: []); HRC removes it with the seat
seat.annotation.act                                   # a client's answer; appends session.annotation.action
```

**`prae` form (live, verified 2026-11-25).** The same facility, reached by a migrated agent through the kernel's generic seat extension type `seat.ext` (owner HRC, register extension); the kernel forwards the caller's identity and the fence verbatim and HRC admits the write exactly as above (D2 holds: HRC changes no code). No `seat.asks` type is declared (`architecture/contracts/praesidium-surface.yaml`: asks are the `hrc/asks/open` annotation projected as `seat.ext`, with no separate node type). The fence is the record's `updatedAt`, because HRC annotations carry no etag; `--expect` takes it as `{"updatedAt": …}`, and `{"updatedAt": null}` requires absence (the create).

```
KEY="--scope-ref <seat> --subject seat --ns hrc --kind asks --id open"
prae ext get $KEY --json                                            # owner read: .result.ext.body, .updatedAt, .updatedBy; not_found = never created
prae ext put $KEY --body @asks.json --expect '{"updatedAt":null}'   # the first record (possibly questions: []); refuses when it exists
prae ext put $KEY --body @asks.json --expect '{"updatedAt":"<prev>"}'   # whole-record fenced write (class fenced); seat, reviewer and deliverer all use it
prae ext act $KEY --action <answered|other|later> --attributes '{"rowId":"<rowId>",…}'   # a client's answer action: unkeyed ledger append (session.annotation.action)
```

The seat-side procedure is the `seat-asks` skill (`var/agents/spaces/seat-asks`). A whole-record rewrite by the seat keeps `review`, `dependsOn` and `sent` on every row it retains: those sub-objects belong to other writers (D3) and the seat carries them through unchanged. `put` maps 1:1 onto `hrc session annotation put` with `--expect-updated-at`; `get` onto `annotation list` filtered to `id == "open"` (the CLI has no single-row `get`, D2); `act` onto `hrc session annotation act`. There is no `delete` in either form (§7). Until r1.6 this paragraph named a dedicated `prae seat asks get|create|update` and `prae seat ext act --row` under kernel record r1.6 §2.4; those verbs are not declared in the live kernel, and the contract text that names them (`architecture/contracts/seat-asks.yaml`) maps onto the `prae ext` forms above.

Events: `session.annotation.changed` on every admitted write (subject, key, op, writer; no body); `session.annotation.action` on every client action against a row (the deliverer records `{rowId, option|other|later, recommended, edited}` as action attributes). The ledger is the history; there is no body history.

## 5. Readers

- **Kernel document:** `seat.ext` records with `ns: hrc, kind: asks` in the `praesidium` document (until the T-12360 read retirement, 2026-11-02, these were rusthrc `hrc.annotation` nodes keyed by `sessionRef`); visibility follows the seat. A reader filters on `{ns, kind}` and renders rows grouped by `task`; the body and fence are owner reads (`prae ext get`).
- **Loggia c2 pane and hrc-ios:** one entry per seat with the record's rows; "Accept recommended"; per-row change / Other / Later; one Send → one `seat.send` to the live generation with text from `assembleAnswers` (T-12235) carrying each question. The c2 layer (cards as rows, Vesta's review, the controller's turn-end backstop, receipts) is `c2/docs/card-contract.md` rev 4 and T-12239.
- **Any other client** may read and answer; a client that answers must stamp `sent` or ask its controller to.

## 6. Relation to the taxonomy

In the Praesidium data taxonomy (`diagrams/taxonomy.arris-board.json`) this record is seat **state** (current truth, CAS-fenced), owned by HRC because HRC mints the seat key. It is the first HRC-owned annotation kind. The same pattern — a seat-owned state record plus a controller turn-end backstop with a detector per record — is specified generically in T-12239 and reused for `seat.work` (workstream binding) under a separate task.

## 7. Explicitly unsupported

Seat-initiated delete of the record (D-F1: the record persists, empty, until HRC retires it with the seat); HRC-side writer authority or per-kind admission; a touch primitive or attention/generation fence on this record; a declared node type in this revision; body history; dedupe of rows by text; a shared decision record or auto-answering a new row from an old ruling; rows on task seats; HRC reading or validating rows; inferring questions from conversation text (the backstop is a nudge to the seat, never a writer); migration of existing `c2.card` rows (they drain under c2's prune).

## 8. Acceptance (HRC side; the product claims are T-12239's five gates)

1. **Round trip under the real facility.** A real non-task seat puts an `hrc.asks` record with two rows through `hrc session annotation put` with `--expect-updated-at`; a second put with the stale value refuses `stale_annotation`; the kernel document shows one `hrc.annotation{ns: hrc, kind: asks}` node for the seat with both rows; `session.annotation.changed` has one row per admitted put. Readback from `seat_annotations` and `hrc_events`.
2. **Rotation keeps the record.** Rotate that seat: the node is unchanged, `updatedAt` unchanged, no `session.annotation.changed` row across the rotation for `ns: hrc`.
3. **Two readers, one record.** The Loggia c2 pane and hrc-ios render the same rows from the same record (screenshots), and an answer from either stamps `sent` on the row with the deliverer named.

## 9. Open for Daedalus

- D1 one-record-many-rows versus one-record-per-row: the trade is atomic seat edits against per-row CAS; the seat is the only row writer in practice, so the whole-record CAS is sufficient.
- D6 timing of the typed node.

## 10. Revision log

- r1.6 (2026-11-25, editorial, docs review T-14574): §4 `prae` form replaced by the live `prae ext get|put|act` forms on `seat.ext` (no `seat.asks` type is declared; fence `--expect {updatedAt}`, row id in `--attributes`); §5 kernel reader names `seat.ext` in the praesidium document per the T-12360 amendment in `architecture/contracts/seat-asks.yaml`. §3 row grammar and every HRC-side decision unchanged; no contract change.

- r1.4 (2026-11-02, editorial, Vesta EN-41005): §4 hrc read form corrected to `hrc session annotation list … --json` selecting `id == "open"`; the installed CLI has `list|put|delete|act` and no `get`. The `prae seat asks get` form is unchanged and maps onto that filtered list. No HRC change (D2).

- r1.3 (2026-11-02, editorial, after Vesta's card-contract rev 4 questions): `sent.runId` optional; the hrc form says `--body-file` (the installed flag; the `prae` form keeps wrkq's `@file`); the seat's whole-record rewrite preserves other writers' sub-objects on retained rows (D3).

- r1.2 (2026-11-02): §4 adds the `prae seat asks get/create/update` and `prae seat ext act` forms under the kernel record's verb grammar, fence = `updatedAt`, class `fenced`, mapped 1:1 onto the existing `hrc session annotation` forms; no HRC change (D2 unchanged). Reason: step 1 of the kernel campaign (P-00919) needs every seat record named in the grammar before the parity table closes.

- r1.1 (2026-11-01, EN-40695 F1): §3 record-level — the seat never deletes; empty is the none state; absent reads as epoch. §4 delete removed from the seat's operations. §7 adds seat-initiated delete. Reason: the T-12239 backstop dedupe compares `ping.at` with the record's `updatedAt`; permitted deletion made "answered then deleted" indistinguishable from "ping unanswered" (`crates/hrc-store/src/annotations.rs#Store.delete_annotation` removes the row outright).
