# The Praesidium data taxonomy and the praesidium document

Status: r1.1, 2026-11-01, draft for Daedalus review (T-12244); r1.1 resolves Daedalus F1–F3 of EN-40706 (unattached promises placed; state fencing scoped to third-party writes; M1 import of project-scoped legacy handoffs). **Not for implementation: Lance is weighing whether the change is worth making.** Owner mable@hrc-runtime:primary. Rulings by Lance on 2026-11-01 are marked **RULED**. Diagrams: `diagrams/taxonomy.arris-board.json#taxonomy-subjects` (the nine subjects and their relationships), `diagrams/seat-data.arris-board.json` (the seat in depth, T-12183/T-12239).

## 0. Claim

Praesidium's data types grew organically in three systems over a year: wrkq (Go, the shared ledger: tasks, conversations, obligations), HRC (Rust, execution: seats, generations, runtimes) and agent-spaces (agents, as profile directories). Each names its records after itself (`hrc.seat`, `wrkq.task`, `aspd.compile`), each has its own escape hatch for client-owned data (`seat_annotations` in HRC; `tasks.meta` keys by convention in wrkq), and a reader that wants "this seat, its agent, its task, its workstream, its pending handoff" joins three stores by hand with keys spelled four ways.

This record does two things:

1. **A taxonomy.** Every record is classified by its **subject** (what it is about: one of nine) and its **register** (what kind of truth it holds: one of five). A record lives with the system that mints its subject's key; a record about two subjects lives with the one whose lifecycle ends it. Type names are `subject[.kind]`; the minting system is the *provider*, not part of the name.
2. **One document.** Readers mount one cardo document, `praesidium`, that projects every subject from every system under taxonomy names, with real hierarchies across systems once cardo can place a node under a parent. The write side is unchanged: HRC, wrkq and agent-spaces keep their stores, APIs, fences and authority. **The read model is unified; the write models are not merged.**

**RULED (Lance):** the separation into three systems was made for ownership boundaries; those boundaries pay on the write side (authority, fences, failure isolation, deploy cadence, federation) and never bought a reader anything. Unify the document. Handoffs belong to the seat and move to HRC. Agents stay in `var/agents` and are represented, not moved. hcs is renamed **workstream** and returns to use; a seat decides when its thread becomes a workstream. c2 is Lance's own workflow; a seat's open questions are a generic capability (`seat.asks`, T-12239).

## 1. Today, verified 2026-11-01

- **HRC kernel document** (`crates/hrc-domain/src/declarations.rs`): five flat root observation types, `hrc.project`, `hrc.seat`, `hrc.generation`, `hrc.runtime`, `hrc.annotation`; relations are payload keys; `links: []` on every node. Live on max3: 25 / 228 / 242 / 89 / 162 nodes. **Strictly node-local:** no seat pinned to svc or hrcdev appears in max3's document. The only open-schema type is `hrc.annotation` (`{subject: seat|generation, ns, kind, id, body ≤ 64 KB, fence}`); all 162 live rows are `ns: c2` (`card` 144 generation-scoped, `ask` 4, `receipt` 13, `config` 1). HRC names no kind of its own.
- **wrkq** (`internal/workrpc/catalog.go`): twelve RPC nouns, each owning an id prefix and a table family — `container` P-/A-, `task` T-, `comment` C-, `attachment` ATT-, `room` R-, `envelope` EN-, `promise` PR-, `handoff` H-, `workflow`, `relation`, `index`, `webhook`. No campaign noun: campaigns exist as a room kind (78 of 2,207 rooms) and a query. Client-owned data lives in `tasks.meta` (keys `workflow` 1,313, `hcs_target`/`hcs_target_root`/`hcs_agent` 125, `triage_*` 51, `acp` 32, a refactor tuple 69) and `tasks.labels` (`refactor` 332, `hcs` 135, …) with no ns, kind, fence or declared writer. `event_log` (207,677 rows, monotonic id) is a cursor-able feed of every mutation. The canonical store is on mini (`rpc://mini`); every node reaches it the same way.
- **agent-spaces**: `var/agents/<id>/agent-profile.toml` (identity, provisioning, spaces, placement, session defaults) is parsed and validated by raspd (`crates/raspd/src/reads/profile.rs`) for `aspc.resolveRuntimeDeclaration`, but the aspd kernel document (`crates/aspd-domain`) declares only `aspd.service`, `aspd.upstream`, `aspd.op`, `aspd.compile`. The agent is a resolution input, not a subject. The seat key `agent:<id>:project:…` is derived from the agent id (`contracts/agent-scope`). A seat's `session_metadata.appearance` (1,190 rows, writer `aspc`, source `launch`) is copied from the profile at every launch.
- **Keys are spelled four ways:** `agent:mable:project:x:task:y/lane:main` (`sessionRef`), `agent:mable:project:x:task:y` (`scopeRef`), `mable@x:y` (envelope from/to, room members), task uuid vs `T-` id. `tasks.project_uuid` holds the immediate container, not the project.
- **Free seats do most of the work:** since 2026-10-01, 930 of 1,786 task writes came from seats with no task in their key (`primary`, `nova`, `graphhelper`, …) against 856 from task seats. The runtime already treats them differently by parsing the key (`seat_retirement.rs:30–44`, `standing_seat`); the model has nowhere to say it.
- **cardo:** keyed `upsert` leaves every node a root in every hierarchy (`cardo-core/src/doms.rs::upsert`); keyed-parent placement is filed, not built (seat-annotations D5). Every node reaches every subscriber on resync and through the 32 MB / 4096-event ring (the reason for the 64 KB body cap). The registry keys node types by bare name with the provider recorded beside them; no prefix is required.
- **Handoff today:** a wrkq table keyed by a scope string wrkq does not mint; 773 rows (751 acknowledged, 22 pending); the rotation turn request says "run `wrkq handoff get H-…`".

## 2. The taxonomy

### 2.1 Subjects

| subject | key | minted by | identity today |
|---|---|---|---|
| **agent** | `agent:<id>` | agent-spaces (`var/agents/<id>/` exists; `archived-agents/` retired) | `agent-profile.toml [identity]` |
| **project** | `projectId` (slug) · P- | wrkq | `containers kind=project`; mirrored `hrc.project` |
| **work group** | P- / A- | wrkq | `containers kind=directory\|feature\|area`; a campaign is a feature + its room |
| **task** | T- | wrkq | `tasks` kind task \| subtask \| bug \| chore \| spike |
| **workstream** | T- (`kind=workstream`) | wrkq | today an hcs task + three meta keys |
| **room** | R- | wrkq | `rooms` kind task \| campaign \| project \| adhoc; members are seats |
| **seat** | `scopeRef` = agent × project × lane | HRC | `hrc.seat`; **kind ∈ {task, standing, adhoc}** (new); the join of all three systems |
| **generation** | `hostSessionId` | HRC | `hrc.generation`, N of a seat |
| **runtime** | `runtimeId` | HRC | `hrc.runtime` |

A thing is a subject when other records are about it and it has its own lifecycle. A promise is not a subject (nothing is about a promise): it is an obligation record owned by a principal. Its subject is the task or container it references; a promise that references neither (`wrkq/internal/domain/promises.go`: a principal-owned text subject; PR-00006 open on 2026-11-01, 10 of 198 retained) is the owner's own commitment and is placed on the **agent** row. A workstream is (a seat is bound to it, tasks fall under it, notes are about it; it opens and closes on the human's attention, not on any task's).

### 2.2 Registers

| register | meaning | write discipline | ends |
|---|---|---|---|
| **identity** | the thing exists; this is its key | written once by the minting system | retired, never edited |
| **state** | the current truth, one value at a time | overwritten in place; a **third-party** write is fenced (`etag`, `expect.updatedAt`); the owner's own writes follow the owner's contract (launch-replaced session metadata is last-writer-wins under `hrc-runtime.session-identity-metadata`, unchanged) | superseded |
| **obligation** | owed from A to B, open until discharged | two parties, a lifecycle, a deadline or trigger; someone can be late | discharged, withdrawn, failed |
| **ledger** | what happened | appended, never changed; ordered; retention is a policy | never (keep-forever by default in this fleet) |
| **extension** | an opaque body a third party attaches to a subject it does not own | `{subject, ns, kind, id, body, fence}`; the writer owns the schema; the ns names it | with its subject, or by its writer |

The register fixes the write API **as seen by a reader or third-party writer**: state takes a fence, ledger takes a cursor, obligation takes a discharge verb and a lateness query, extension takes a namespace. It does not rewrite an owner's internal write path; where an active owner contract says a write is unfenced (launch metadata), the type declares it (`writable: owner`) and a reader learns it has no fence to supply. Several records are in the wrong register today: a handoff is stored as state with a status column and behaves as an obligation.

### 2.3 Rules

- **R1 Minting.** A record lives with the system that mints its subject's key. A record about two subjects lives with the one whose lifecycle ends it (a handoff is owed between two generations of one seat and consumed by the rotation → HRC; an envelope is between two seats inside a conversation and ends with the room → wrkq).
- **R1a Obligations between principals.** An obligation owed between parties (envelope, promise, workflow obligation) lives in the collaboration ledger, wrkq, whatever subject it is about, because wrkq owns the obligation register between parties. An obligation internal to one subject's lifecycle (a handoff between two generations of one seat; a claim on a task) lives with that subject's minter. R1 names the home; R1a names the exception and why.
- **R2 Naming.** Type names are `subject[.kind]`: `seat`, `seat.asks`, `seat.handoff`, `task`, `task.comment`, `room.envelope`, `agent`. The provider (who declares and serves the type) is recorded beside the name, as cardo already does. `hrc.*` and `aspd.*` are legacy names retired when readers have moved to the praesidium document.
- **R3 Durability vs projection.** Keeping is a store property; projecting is a window. Every store keeps forever unless a retention rule is approved; the document shows only the current situation per subject (identity and state as nodes; obligations as nodes until discharged plus a short window; extensions as opaque nodes; ledger never, except as derived "latest" fields).
- **R4 Canonical keys.** In every payload: `scopeRef` for seats (`sessionRef` only where the lane matters), the public id (`T-`, `P-`, `R-`, `EN-`) for wrkq subjects, `agent:<id>` for agents. `mable@x:y` handles and uuids are display and storage forms, never join keys.
- **R5 Authority after a move.** When a record moves between systems, the record names the commit from which the new home is authoritative; the old rows become history and are never projected.

### 2.4 Placement

| subject | identity | state | obligation | ledger | extension |
|---|---|---|---|---|---|
| agent | profile `[identity]` | resolved profile + hash, status | promise with no task/container (the owner's own commitment; stored in wrkq, R1a) | `aspd.compile` by agentId; campaign logs | `skills/ memory/ brain/ SOUL.md` by convention |
| project | container kind=project | description, webhooks | — | project_events | *(ext, new)* |
| work group | container directory\|feature\|area | title, sort | promise (subject=container) | container.* events | *(ext, new)* |
| task | task + relations | state, assignee, claim, spec, workflow instance | claim · promise · workflow obligations | transitions, comments, evidence, attachments, ledger_entry | **`tasks.meta.*`/labels → ext** (move) |
| workstream | task kind=workstream, owner | title, `covers` (task ids or a container) | — | task events | — |
| room | room kind=subject, members | state, last_activity | **envelope** (reply_required / fyi / note) | envelope.* events, presentations | — |
| seat | `hrc.seat`, **kind** | presentation and appearance (owner-written at launch, unfenced by contract); **`seat.asks`** (new); **`seat.work`** (new, → task \| workstream \| none) | **`seat.handoff`** (move from wrkq) | `hrc_events` by scope | `c2.config / ping / receipt` (controller's own) |
| generation | `hrc.generation` | status, attention | — | turns, runs | allowed; c2 writes none |
| runtime | `hrc.runtime` | status, transport, hrcpty/tmux, context | — | broker events, bipc | — |

## 3. The praesidium document

### 3.1 One provider, one mount

A cardo provider `praesidium` declares every subject in §2.1 under its taxonomy name, with the register and the minting provider as declared attributes on the type (beside `hints`), and a `live_until` rule per type. Loggia, hrc-ios (through ACP) and any other reader mount **one** document. The three systems keep their stores and APIs; the provider is a projection, rebuildable from its feeds.

### 3.2 Feeds

| feed | source | cursor | projects | scope |
|---|---|---|---|---|
| hrc | `hrc_events` + store reads, as the current `hrc.*` projector | hrc_seq | seat, generation, runtime, seat.asks, seat.handoff, extensions | **per node** |
| wrkq | `event_log` over `rpc://mini` + store reads | event_log id | project, work group, task, workstream, room, pending envelopes, open promises, task extensions | global |
| agents | `var/agents` (file watch + raspd's profile read) | mtime set / hash | agent | global |

Each feed has its own catch-up and reports it (`reports_catch_up`), and its **cursor age is a declared field on the document** (`feeds.wrkq.asOf`). A feed that is behind leaves its subjects **stale, never absent**, and a pane shows "tasks as of 14:02" instead of a hole. This is how the failure isolation of three systems survives the merge: wrkqd on mini can be down and the seats keep projecting.

### 3.3 Cross-node seats (the one place "global vs per-node" does not go away)

HRC's document is node-local today (§1). The praesidium document on a node projects that node's seats from the local hrc feed; seats on other nodes come from the same feed shape over federation (a per-node `hrc_events` follower with its own cursor, read-only, under the existing federated-session-read invariant), or they are absent as today. **Open for Lance:** whether the first revision includes remote seats. Without them the document is honest (its `feeds` list names which nodes it follows); with them Loggia on max3 shows svc's seats for the first time.

### 3.4 Operations

The provider declares the operations readers invoke (`summon`, `send`, `seat.annotation.put/act`, `task.create`, `room.say`, `handoff.acknowledge`, …) and delegates each to its owner: HRC operations by in-process owner dispatch as today, wrkq operations as `wrkqd` RPC calls, nothing for agents (edit the profile). Fences are the owner's (`expect.updatedAt`, `--if-match`); the provider adds none. Write authority does not move.

### 3.5 Hosting (open for Lance)

Per node, because Loggia is per node and the hrc feed is local. Two placements:
- **inside rusthrc**, which already embeds cardo and hosts the `hrc` document — no fourth daemon, but HRC then *reads* wrkq at runtime (optional, degradable), a dependency-direction change against the "HRC client-agnostic" ruling of 2026-09-17;
- **a separate `praesidium-kernel` process** per node — HRC stays pure; one more supervised process.

Recommendation: rusthrc-hosted with the wrkq and agents feeds optional and degradable; the `hrc` document stays until readers have moved, then retires (R2).

### 3.6 Live windows (fan-out)

Projection size, not storage, is the constraint (§1, cardo ring). Per type: seat/generation/runtime as today (generation: runtime gone + 24 h); `seat.handoff` pending + 24 h after acknowledge; envelope pending or presented, gone on terminal; task open or in_progress or blocked in a project with a live seat, plus any task a live seat's `work` names; workstream open; room with activity in 7 days; agent all; project all; work group with a projected task. Windows are declared on the type and tunable without a schema change.

### 3.7 Lineage

Solid edges on the subjects frame are hierarchies: `agent ⊃ seat ⊃ generation ⊃ runtime`, `project ⊃ work group ⊃ task`, `agent ⊃ workstream`. They are declared once cardo's keyed-parent upsert lands; until then they are payload keys (R4) and readers filter. Dotted edges (`project of`, `task seat`, `members`, `covers`, `on`) stay keyed references.

## 4. Moves

| # | move | from → to | register | authority after |
|---|---|---|---|---|
| M1 | **seat.handoff** | wrkq `handoffs` → HRC `seat_handoffs` (keep-forever), `hrc handoff create/get/acknowledge`, rotation injects the pending handoff into generation N+1's first turn; `wrkq handoff` shim then retired. **Import (F3):** legacy rows are project-scoped by design (`wrkq.handoff.caller-owned-scope`: `agent@project`, task/role discarded — H-00741 minisvc and H-00742 hrcdev share `agent:mable:project:hrc-runtime`), so no stored key names the seat. Every imported row keeps `legacyScope` and gets `seat = null`; acknowledged rows are history, listable by `hrc handoff list --project`, never projected; the pending rows (22 on 2026-11-01) are assigned their seat **by hand at cutover** by the owning agent, from the titles, before the shim retires — never by code reading the text. New handoffs key by full seat scope + lane; `hrc handoff create` from a seat defaults to that seat | obligation (N → N+1) | HRC from the landing commit |
| M2 | **seat.asks** | c2 cards (generation-scoped) → one seat record, T-12239 | state | HRC (`ns: hrc`) |
| M3 | **seat.kind, seat.work** | key parsing → declared fields; `work` is late-bound (skill rules bind/promote; backstop detector) | identity, state | HRC |
| M4 | **workstream** | hcs task + `meta.hcs_*` → task `kind=workstream`, `owner`, `covers`; `seat.work` replaces `hcs_agent`; `hcs` CLI and `track-in-hcs` renamed | identity, state | wrkq |
| M5 | **wrkq extension register** | `tasks.meta.*` conventions → `{subject: task\|container\|room, ns, kind, id, body, fence}`; writers migrate one by one | extension | wrkq (**Lance approval: wrkq contract**) |
| M6 | **agent node** | raspd read → `agent` type in the document (resolved profile, hash, status) | identity, state | agent-spaces (storage unchanged) |

## 5. Decisions

| id | decision | why |
|---|---|---|
| D1 | Unify the document, not the systems. | The boundaries pay on the write side; a reader never benefited from three documents; lineage across systems needs one. |
| D2 | Taxonomy names from day one on the new provider; legacy `hrc.*` retired by mount switch, not rename. | No consumer migration of 40 Loggia sites; the old document simply stops being mounted. |
| D3 | Register, provider and writability (`writable: owner \| fenced \| none`) are declared attributes on every type. | A pane learns mechanically which fields take a fence when *it* writes, which nodes vanish on discharge, which bodies are opaque; owner-internal writes keep their contracts (F2). |
| D4 | Stale, never absent; cursor age per feed on the document. | Keeps three-system failure isolation visible to readers. |
| D5 | Durability is the store's; projection is a window (R3). | Handoffs, envelopes, workstreams are kept forever and projected while live. |
| D6 | Canonical keys (R4) ruled before any projector is written. | The cheapest decision and the one that bites daily if skipped. |
| D7 | `seat.kind` explicit; `seat.work` late-bound; promote-by-default under the lane name with merge/rename on the board. | Lance never types a task or workstream name before talking to a seat; the seat decides when its thread becomes a workstream; the backstop asks only when the turn made work real. |
| D8 | wrkq's extension register has the same shape as HRC's annotation. | One shape across the fleet; one filter in a pane. |

## 6. Explicitly unsupported

Merging the daemons or stores; moving write authority or fences into the provider; HRC validating wrkq or agent bodies; projecting any ledger (comments, events, transitions) as nodes; projecting closed tasks, terminal envelopes or archived anything (R3 windows); inferring `seat.work` from conversation text or from provenance alone (a primary that mints a campaign has touched twelve tasks and is on none); inferring a legacy handoff's seat from its text (F3: hand assignment of the pending rows at cutover); fencing the owner's own launch writes (F2); renaming wrkq RPC nouns; an agent store outside `var/agents`; lineage hierarchies before cardo's keyed-parent upsert; per-field history in the document.

## 7. Open for Lance

1. Whether the change is worth making at all (this record is written for the ruling, not for implementation).
2. Hosting: inside rusthrc or a separate per-node process (§3.5).
3. Remote seats in revision one (§3.3).
4. M5, the wrkq extension register (a wrkq contract change).

## 8. Acceptance, if built (product claims; readback from the document, the stores and screenshots)

1. **One mount, one seat, everything about it.** Loggia mounts `praesidium` only and shows for a real free seat: its agent (model, harness, placement), its project, its `work` (a workstream and the tasks it covers), its pending `seat.handoff`, its `seat.asks` rows, its current generation and runtime, and the rooms it is a member of — with no second mount and no key join in the pane.
2. **Stale, never absent.** Stop wrkqd on mini: the document's `feeds.wrkq.asOf` stops advancing, every wrkq subject stays visible, a pane shows the age; seats keep updating. Start it: the cursor catches up and the age closes.
3. **Rebuild.** Delete the document's state on a node; it rebuilds from the three cursors to the same node set (counted per type) as before.
4. **Authority after M1.** After the handoff move, `hrc handoff list --scope … --all` returns the imported history plus new rows; the document projects only pending + 24 h; `wrkq handoff` forwards and then is gone.
5. **Guard.** Declaration tests: every type carries subject, register and provider; every payload key named in R4 is the canonical form; no `hrc.*` name on the new provider.

## 9. Sequence (if ruled worth it)

0. This record approved. Canonical keys (R4) and `seat.kind` ruled.
1. HRC additive: `seat.kind`, `seat.work`, `seat.asks` (T-12239), `seat.handoff` (M1) on the existing projector, with taxonomy names.
2. `agent` node (M6).
3. cardo keyed-parent upsert.
4. The `praesidium` provider: declaration, hrc feed (reusing the current projector), agents feed, wrkq feed with the live window; hosting per §3.5.
5. Loggia moves its mount; the `hrc` document retires.
6. M4 workstream and M5 extension register as their own campaigns under their own rulings.

## 10. Revision log

- r1.1 (2026-11-01, EN-40706): F1 — unattached promises placed on the agent row, R1a added for obligations between principals. F2 — state fencing scoped to third-party writes; `writable` declared per type; launch metadata stays last-writer-wins. F3 — M1 import: `legacyScope` + `seat = null` for history, hand seat assignment of the pending rows at cutover, new handoffs keyed by full seat scope.
- r1 (2026-11-01): first draft, written after a day of iteration with Lance from the hrc-runtime seat; supersedes the three-documents-joined-by-key shape discussed earlier the same day.
