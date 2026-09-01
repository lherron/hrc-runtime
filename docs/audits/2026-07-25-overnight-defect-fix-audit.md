# Overnight HRC defect-fix audit — 2026-07-25

Auditor: Cody (`cody@hrc-runtime:minisvc`)
Inventory frozen: 2026-07-25 08:03:50 CDT
Window: 2026-07-24 17:03:50 CDT through inventory freeze (15 hours)
Source snapshot: `cody/handoff-00291` at `3adbe9c4a224c28f376b96c137271a843a85ef52`
Independent second review: Clod (`clod@hrc-runtime:minisvc`), given the same frozen inventory; no findings were exchanged while either review was in progress. See [Clod's full independent report](2026-07-25-overnight-defect-fix-audit-clod.md).

## Executive grade

**C — substantial good work, but the batch is not acceptable as a security/durability release without follow-up.**

The batch is unusually broad and generally well tested. Most changes are careful, fail closed, and have strong durable/live evidence. Build, typecheck, repository checks, the focused audit matrix, and the full `just verify` suite pass. The installed svc daemon also names the audited source SHA and reports that the running and installed releases match.

That evidence does not cover the following contract failures found by source review:

1. One **critical** authority-boundary failure in T-05439: an untrusted caller can mint its own “manual operator approval,” and the write lane is constrained by an agent prompt rather than an HRC-enforced write boundary.
2. Two **high** delivery/idempotency failures: T-06592 has a crash window before the idempotency key is made durable, and T-06809 can report a remote turn failed while its durable outbox item remains eligible for later execution.
3. Two **medium** correctness/performance gaps: T-06802 still performs unbounded/N+1 work for common limited history queries, and T-06090 cancels a scheduled event-gap repair when the gap-revealing event is terminal.
4. Clod independently found and Cody reproduced a **high** user-facing selector split: `show/thread` use collective sequence while `trace` uses node-local sequence, so printed identifiers do not round-trip.
5. Clod found a **medium** detached-worktree blind spot where placement fails closed but the completed-task janitor silently ignores the obstructing worktree.

The critical finding controls the overall grade. Without it, the rest of the batch would grade approximately **B+**.

## Independent second-eye comparison

Clod independently recomputed the exact same 57 commits, 42 tasks, and 44 completion transitions before either reviewer exchanged findings. Clod initially graded the batch **B+** and Cody graded it **C**. After both reports were locked, Clod re-read F-1, withdrew the T-05439 A- grade, and revised the independent overall grade to **C** in HRC DM 1381.

Confirmed additions from Clod:

- **High:** T-06579/T-06830 message selectors are mutually inconsistent. Installed DM 1375 has collective sequence 17932: `hrcchat show 1375` fails while `show 17932` succeeds; `trace 1375` succeeds while `trace 17932` fails. `msg:` also works for show/thread but fails for trace. Cody reproduced this after both audits locked.
- **Medium:** a detached, clean, merged, completed-task worktree is rejected by placement but silently skipped by the janitor because task tokens are read only from `worktree.branch`.
- **Medium observability:** recurring broker lease GC emits no successful no-op tick, so a healthy no-op timer and a dead timer are indistinguishable.
- **Traceability:** T-06576's final comment cites nonexistent `7b3afbd2f33fdd651154d8c05f1a978d6249fe87`; the real commit is `7b3afbd84d709b45a6d43755ea9136c8efcd7779`.
- **Integration risk:** production runs the audit branch while it is five commits behind `origin/main`; the merged tree has not run the bar.

Post-comparison convergence and unconfirmed paths:

- **Resolved:** Clod now confirms F-1. The approval hash proves integrity but not operator authenticity; the caller authors both the approval and artifact, and `workspace-write` is not mechanically confined to approved paths. Both reviewers grade T-05439 **F**.
- **Not contested:** Clod did not re-examine F-2 through F-5 after reading Cody's source orderings. The original B/B+ task grades reflect paths Clod did not exercise, not contrary evidence. Cody's crash, timeout, corpus-size, and terminal-gap findings therefore stand unopposed.

Both independent reviewers therefore converge on **C**, with six behavioral reopen/follow-up areas: T-05439, T-06592, T-06809, T-06802, T-06090, and shared selector resolution for T-06579/T-06830. T-06405 needs a bounded detached-worktree follow-up; T-05337 needs timer observability; T-06576 needs only citation correction.

## Scope and method

The audit includes:

- **57 unique commits** whose author/commit timestamp falls in the window on any fetched local or remote ref.
- **42 unique hrc-runtime wrkq records** with a `completed` transition in the window.
- **44 completion transitions** because T-06802 and T-06911 were reopened and completed again.
- Task descriptions/specifications, all retained comments, closure evidence, commit reachability, diffs, focused tests, the repository-wide verification bar, dependency coherence, and read-only installed-surface checks.

Commit reachability at the frozen snapshot:

- 48 commits reachable from `cody/handoff-00291`.
- 3 commits reachable only from `origin/main`.
- 6 commits reachable only from other fetched refs.

Grades weigh production correctness, authority/durability semantics, regression coverage, real-surface evidence, and closure quality. `A` means release-ready evidence; `B` means sound with bounded residual risk; `C` means material follow-up is required; `D/F` means the claimed contract is not delivered. `N/A` is used for a correct no-code or operational disposition.

## Findings

### F-1 — Critical — T-05439 approval authority is forgeable and write containment is prompt-only

T-05439 says a task specification is not approval, mutation approval must be a recorded manual-operator or wrkf approval, HRC owns the split, prompts do not grant authority, and HRC must constrain target paths.

The implementation accepts any readable local `file:` URI with a caller-supplied SHA fragment as an approval record (`packages/hrc-server/src/actuator-split.ts:288-323`). It parses `approvedBy` and `approvedAt` as plain JSON fields and compares the request only with that same file (`actuator-split.ts:326-428`). It does not authenticate a manual operator, resolve a wrkf action against an authoritative ledger, verify a signature, or require protected ownership/mode. The positive test demonstrates the weakness: the test itself creates `approval.json`, writes `approvedBy: "human:lance"`, hashes it, and is admitted (`packages/hrc-server/src/__tests__/t05439-actuator-split.test.ts:240-300`). A task-scoped caller can do the same.

The actuator then receives `workspace-write`; HRC replaces free-form input with instructions telling the agent to apply only approved paths (`actuator-split.ts:573-595, 621-629, 681-687`). HRC does not apply the artifact itself, mount a path-restricted write surface, or verify the postcondition. The artifact file is content-checked once but need not be content-addressed (`actuator-split.ts:520-531`); the prompt later points the agent at the mutable path, creating a time-of-check/time-of-use gap.

The read-only credential split is also incomplete: it scrubs caller launch env (`actuator-split.ts:598-613`) but deliberately preserves compiled `lockedEnv`, while admission does not reject credential-class keys there. A hash-covered read-only profile can therefore retain remote mutation credentials even though its filesystem is read-only.

**Impact:** the claimed high-risk authority boundary can be self-authorized, and an admitted actuator can write outside approved targets.
**Grade:** T-05439 **F**.
**Required disposition:** reopen and block high-risk use. Approval must resolve to an authoritative, non-caller-mintable record; artifact/base validation and mutation must be atomic or revalidated by HRC; target writes need mechanical containment or HRC-owned application; read-only profiles need credential absence/scoping proved from the compiled request.

### F-2 — High — T-06592 idempotency is not atomic with durable run acceptance

At the time of the audit, the route first called `dispatchTurnForSession`, which created/accepted the durable run, and only after it returned updated that run with caller idempotency metadata. A daemon crash between those operations left an accepted run without the caller key. The retry saw no existing key and could create a second run. The in-memory operation map protected only one live process.

Replay also requires the runtime row and throws if it has been pruned, even if the durable run is terminal (`turn-dispatch-handlers.ts:178-190`).

**Impact:** exactly the retry-after-uncertain-acceptance case can duplicate work across a crash, contrary to the durable idempotency claim.
**Grade:** T-06592 **C**.
**Required disposition:** reserve the idempotency key/request hash transactionally before or with run creation, with a unique constraint and a durable replay projection that survives runtime pruning. Add a crash-boundary regression.

### F-3 — High — T-06809 can return failure while the remote turn remains eligible to execute

After a federated semantic turn is durably queued, the origin waits 30 seconds for a started signal (`packages/hrc-server/src/target-message-handlers.ts:769-787`). On timeout it marks the message failed and throws (`target-message-handlers.ts:788-804`) but does not cancel, fence, or dead-letter the outbox item. A sleeping or slow destination can later receive and execute the original turn. A caller reacting to the failure can retry and cause two executions.

There is also a lifecycle-order race. The destination starts the turn before it constructs/routes the `started` signal (`target-message-handlers.ts:1529-1589`). A very fast turn can finalize and route its terminal signal first. The origin avoids regressing the request row from terminal to started, but still appends a late `turn.started` event after `turn.completed` (`target-message-handlers.ts:1739-1758`). Existing tests cover started-before-terminal, not terminal-before-started.

**Impact:** false failure with eventual execution and potentially inverted lifecycle order.
**Grade:** T-06809 **C**.
**Required disposition:** define timeout as pending/unknown unless the durable delivery is successfully cancelled/fenced; make retries reuse a durable semantic-turn idempotency identity; enforce started-before-terminal projection.

### F-4 — Medium — T-06802 common limited history queries still do unbounded work

The forward fix pushes only exact `messageId` and `afterSeq` predicates into SQL. For common `--limit`, `from`, `to`, participant, thread, run, kind, and phase queries, the repository selects every collective message, parses every JSON record, performs one observation query per message, filters and sorts in JavaScript, then slices the limit (`packages/hrc-store-sqlite/src/collective-history-repository.ts:242-303`).

At audit time svc had 17,933 collective messages and 18,430 observations. Installed `hrcchat messages --limit 20 --json` took about 0.55 seconds and `--from cody@hrc-runtime:minisvc --limit 20 --json` about 0.44 seconds. The limit does not bound CPU, allocations, JSON parsing, or query count; cost grows linearly and recreates the class of live CPU failure that caused the reopen.

**Impact:** history remains vulnerable to data-volume-driven latency/CPU growth on ordinary reads.
**Grade:** T-06802 **C+**.
**Required disposition:** add indexed/filterable columns or a bounded candidate query, batch-load observations, and make pagination/limit bound work. Add a large-corpus query-plan/performance regression.

### F-5 — Medium — T-06090 terminal gap events cancel their own repair

When a broker event arrives above the persisted high-water, HRC detects missing sequence numbers and schedules a debounced ledger backfill (`packages/hrc-server/src/broker/controller.ts:1048-1076`). It then maps the arriving event. If that event is `invocation.exited`, `invocation.failed`, or `invocation.disposed`, `afterMappedEvent` immediately cancels the pending backfill and logs the gap unrecoverable (`broker/controller.ts:1251-1268, 1329-1336`).

Thus the important case “terminal event arrives and reveals that preceding output/lifecycle events were dropped” never attempts the available ledger replay. Focused tests exercise nonterminal gap revelation, not a terminal high-sequence event.

**Impact:** terminal event gaps can permanently omit recoverable events and degrade capture/lifecycle evidence.
**Grade:** T-06090 **C+**.
**Required disposition:** perform or await bounded backfill before terminal cancellation, or make terminal cancellation trigger an immediate final replay. Add exited/failed/disposed gap regressions.

## Strong areas

- **T-05337 claimed-lease reaping:** conservative identity classification, recovery-budget exhaustion, race re-read, process-negative IPC cleanup, and shared teardown are unusually thorough.
- **T-06405 worktree pruning:** dry-run default, no force deletion, canonical-root protection, completed-token validation, clean/merged checks, and repeated live-runtime occupancy checks make the destructive surface appropriately defensive.
- **T-06367 through T-06371 placement:** explicit project origin is carried independently of cwd, task worktrees are refined by exact branch token, ambiguity fails closed, and the cwd matrix is strong.
- **T-06576/T-06007 lifecycle control:** durable close marker, startup close-through-warmup, quiescence recheck, caller-scope gate, and live installed evidence are strong.
- **T-05337, T-05577, T-06006, T-06830, and T-06846 closure evidence:** each has concrete commit, full-bar, installed-release, and real-surface evidence rather than unit-only assertions.

## Task-by-task grades

| Task | Grade | Audit disposition |
| --- | ---: | --- |
| T-05113 | A- | Role-scoped monitor aggregation is explicit and collapses historical generations. |
| T-05177 | A- | Interactive-surface reuse veto is threaded and regression-covered. |
| T-05299 | A- | Same-client bounded control proof now precedes active publication; strong restart E2E. |
| T-05337 | A- | Claimed orphan lease reaping is conservative and race-aware; recurring no-op GC lacks a liveness fact. |
| T-05439 | F | Reopen/block: approval is caller-forgeable and mutation containment is prompt-only (F-1). |
| T-05562 | B+ | Managed runtimes receive canonical wrkq authority; side-ref integration evidence is adequate. |
| T-05577 | A- | Authority-correct ASP producer fix, coherent sync, N=5 100KB real concurrency proof. |
| T-05639 | A- | Internal failures now carry request context and SDK-visible cause; focused live route passes. |
| T-06005 | N/A | Correct no-code disposition: incident is no longer reproducible and completed-task scopes remain intentionally usable. |
| T-06006 | A- | FIFO acceptance and queue-age facts are durable and demonstrated on installed runtime. |
| T-06007 | A- | Task sessions fail closed on server lifecycle operations; primary operator path remains explicit. |
| T-06015 | A- | Broker-tmux no-prompt admission drift is corrected with focused route coverage. |
| T-06090 | C+ | Reopen: a terminal gap-revealing event cancels its scheduled repair (F-5). |
| T-06367 | A- | Parent contract is delivered by the four placement steps. |
| T-06368 | A | Explicit-vs-inferred project origin is preserved. |
| T-06369 | A- | Canonical project and exact task-worktree refinement fail safely on ambiguity. |
| T-06370 | A | Unknown explicit projects fail closed with remediation. |
| T-06371 | A | Cwd-invariance matrix covers unrelated, agent-home, and target locations. |
| T-06405 | B+ | Defensive and race-rechecked, but detached task worktrees are silently invisible. |
| T-06457 | A- | Broker payload/status/exit semantics align with the producer contract and focused coupling tests. |
| T-06566 | A- | Consumer receipt occurs after decode and transport accounting is durable/bounded. |
| T-06576 | A- | Behavior is strong; the final closure cites one nonexistent full SHA. |
| T-06579 | C | Thread reconstruction works, but its printed/local sequence does not round-trip through show/thread. |
| T-06582 | A- | Dispatch timing tests use deterministic synchronization rather than wall-clock assumptions. |
| T-06587 | A | Monitor follow uses targeted incremental state, bounded windows, and stdout backpressure. |
| T-06588 | A- | Correct disposition/regression: old-generation teardown behavior is now intended and guarded. |
| T-06592 | C | Reopen: run acceptance and idempotency-key persistence are not atomic (F-2). |
| T-06593 | A- | Same-runtime skip-dispatch branch has the intended anti-busy/not-live guard. |
| T-06719 | B+ | Liveness-gated tmux aging is materially improved; retained evidence is less strong than the A-grade live paths. |
| T-06801 | N/A | Correct architecture/cross-repo disposition; no HRC-only behavior was falsely claimed. |
| T-06802 | C+ | Reopen: common limited history reads still scan/parse/query the full corpus (F-4). |
| T-06809 | C | Reopen: timeout can report failure while durable delivery later executes (F-3). |
| T-06825 | A- | Canonical Verdaccio cutover is operationally evidenced and dependency coherence passes. |
| T-06830 | C | Trace evidence is rich, but selector resolution is incompatible with show/thread and documented prefixes. |
| T-06846 | A | Abnormal provider terminal and broker-close fallback converge on one canonical crash; installed smoke is strong. |
| T-06911 | A- | Reopened fixture issue was forward-fixed; literal capture no longer depends on ambient prompt width. |
| T-06912 | N/A | Correct already-delivered closure; no duplicate code was invented. |
| T-06931 | A- | CLI helper deduplication landed on main with tests and public-surface checks. |
| T-06932 | A- | `cli-runtime.ts` split is behavior-preserving and repository checks pass. |
| T-06947 | A- | Federation tests no longer consult ambient host state. |
| T-06958 | A- | Atomic release provenance is exposed and installed readback names exact source/release. |
| T-06963 | A- | Cache-empty lab cutover is an operational completion with retained evidence. |

## Validation evidence

Passed:

- `bun run build`
- `bun run typecheck`
- `bun run check:boundaries`
- `bun run check:public-surface`
- `just check-deps`
- `git log --all --since=<cutoff> --check`
- `git diff --check`
- Focused audit matrix: **107 pass, 0 fail**, spanning actuator admission, semantic federation, collective history, durable dispatch ACK, claimed-lease reaping, broker gap repair, subscriber receipts, monitor memory, placement, worktree pruning, tmux aging, release provenance, capture verification, and internal-error observability.
- `just verify`: architecture, boundaries, manifests, public surface, suppressions, lint, typecheck, all package tests, and federation loopback.

Read-only installed checks:

- svc running release: `release-20260725125201835-66294`
- installed source SHA: `3adbe9c4a224c28f376b96c137271a843a85ef52`
- `runningEqualsInstalled=true`
- dependency coherence: ASP `0.1.1-dev.20260725012231`; WRKQ `0.1.0-dev.20260724225231`

No install or daemon restart was performed for this audit because the only authored change is this report and the running installed source already matches the audited snapshot.

## Frozen commit inventory (57)

Current audit branch (48):

`e03ad60 cfcb6a1 32da29b 05e0bba 109e86a 4c25e47 300d6ab a95976b e966905 6b306fb 6c292f5 e9a6419 c8c5db2 60862ee 26c6260 80351cb 6285fae 73b6abf 50c7964 5fec3b4 9074a65 b417f92 4371257 b1f9841 126ba52 c0db0fc 687bc94 79d2893 75a7979 3952456 bcec1a9 df7724b 68e870f 7b3afbd 2d91ca7 dc76a07 a628fc5 b795a5e 7cbe2ef 20d728f 55c9cd4 ae154ae 3490b29 5abb8b6 b871b5f 6e4a964 66f84a2 3adbe9c`

`origin/main` only (3):

`edeb63b 595f0da e83d07c`

Other fetched refs only (6):

`ee8c90f f37c8d7 2550dc0 22d29a0 bd63001 43c9538`

## Frozen wrkq inventory (42)

`T-05113 T-05177 T-05299 T-05337 T-05439 T-05562 T-05577 T-05639 T-06005 T-06006 T-06007 T-06015 T-06090 T-06367 T-06368 T-06369 T-06370 T-06371 T-06405 T-06457 T-06566 T-06576 T-06579 T-06582 T-06587 T-06588 T-06592 T-06593 T-06719 T-06801 T-06802 T-06809 T-06825 T-06830 T-06846 T-06911 T-06912 T-06931 T-06932 T-06947 T-06958 T-06963`
