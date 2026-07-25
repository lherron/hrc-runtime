# Independent second-eye audit — Clod — 2026-07-25

Auditor: Clod (`clod@hrc-runtime:minisvc`)
Audit response: HRC DM 1379
Window: 2026-07-24 17:03:50 CDT through 2026-07-25 08:03:50 CDT
Independence: completed without reading Cody's findings; no files, tasks, services, or installed state were mutated.

## Overall grade

**B+ — high confidence** on inventory, placement, worktree janitor, lease state, and selector grammar; **medium confidence** on federation and destructive lease-reaping paths, which were reviewed but not exercised.

The batch has clean gates, generally spec-faithful implementations, and strong closure evidence. It is held below A by one reproduced user-facing selector defect, one conflict between same-night placement and janitor features, and the production release running from an unmerged branch that is five commits behind `origin/main`.

## Independently recomputed inventory

- 57 commits: 48 audit-branch, 3 `origin/main`-only, 6 other-ref-only; hashes match the frozen set.
- 42 unique hrc-runtime tasks across 44 completion transitions.
- Reopened/recompleted: T-06802 and T-06911.
- Recomputing transitions from `wrkq log --patch` excluded 16 records whose `updated_at` was in-window but which had no in-window completion transition. Using `updated_at` alone would incorrectly yield 58 records.

## Validation

- Ordered build: 13 packages pass.
- Typecheck: 13 packages pass.
- Biome: 782 files pass.
- Architecture records, boundaries, manifests, public surface, and suppressions pass.
- Full `bun run test`: 3,525 pass, 0 fail, 11 skip.
- Installed daemon: source `3adbe9c`, release `release-20260725125201835-66294`, `runningEqualsInstalled=true`.

## Findings

### H1 — High — `hrcchat` selector grammar is broken and inconsistent

Affected: T-06579 / `55c9cd4`, T-06830 / `7cbe2ef`.

Installed reproduction using DM 1375, whose collective sequence is 17932:

| Selector | `show` | `thread` | `trace` |
| --- | ---: | ---: | ---: |
| `17932` (collective sequence) | pass | pass | fail |
| `seq:17932` | pass | pass | fail |
| `1375` (node-local message sequence) | fail | fail | pass |
| full message ID | pass | pass | pass |
| `msg:<message-id>` | pass | pass | fail |

`hrcchat messages` prints both identities as `@<collectiveSeq>/#<messageSeq>`. `show` and `thread` resolve numeric selectors through collective history (`packages/hrcchat-cli/src/commands/message-selector.ts:42-64`), while `trace` resolves the numeric selector as node-local `messageSeq`. `show` prints `#1375` as the message identity and then refuses `1375` as input. `trace` also rejects the `seq:` and `msg:` forms documented by the CLI.

The thread fixtures always populate `collectiveSeq`, so the absent-collective-sequence path is not covered.

**Disposition:** reopen/file one task for a shared selector resolver. Accept both sequence spaces with explicit syntax matching the displayed `@N/#N`, make printed identities round-trip, and add tests without `collectiveSeq`.

### M2 — Medium — Detached task worktrees are invisible to the janitor and rejected by placement

Affected: T-06405 × T-06369.

`packages/hrc-cli/src/worktree-prune.ts:389-393` extracts task tokens only from `worktree.branch`; detached worktrees have no branch and are silently ignored, not even emitted as skipped.

Live evidence: `/Users/lherron/praesidium/under-construction/hrc-runtime-T-06602` is detached, clean, merged, and belongs to a completed task. Placement correctly fails closed because the detached branch cannot carry the task token, but the janitor built to clean completed-task worktrees cannot report or remove it.

**Disposition:** the janitor should explicitly report detached task-path worktrees. An opt-in removal path may reuse the completed/clean/merged/live-occupancy gates.

### M3 — Medium — Periodic broker lease GC has no no-op liveness signal

Affected: T-05337.

`packages/hrc-server/src/sweep-handlers.ts:529-563` emits `broker.lease_gc_sweep_complete` only when a sweep changes state or reports an error. No such line exists in the retained server log, so an operating no-op timer and a dead timer are externally indistinguishable. This matters because the timer can kill live lease servers and the task already required multiple safety cycles.

Live estate inspection found 80 lease sockets, all claimed by nonterminal runtimes, and zero orphans. That is healthy but cannot prove the recurring timer is firing. The sibling tmux-aging timer does emit periodic summaries and was directly observable.

**Disposition:** expose a last-run/tick fact in status or emit a periodic no-op-safe summary.

### M4 — Medium traceability — T-06576 closure cites a nonexistent commit

The final task comment cites:

`7b3afbd2f33fdd651154d8c05f1a978d6249fe87`

That object does not exist. The actual commit is:

`7b3afbd84d709b45a6d43755ea9136c8efcd7779`

This was the only invalid commit citation among 53 `(task, 40-hex)` closure pairs.

**Disposition:** correct the comment in place; no behavioral reopen is required for this typo.

### Low findings

- Worktree mergedness is checked against the canonical checkout's current `HEAD`, not its default/upstream branch (`worktree-prune.ts:476-483`). This is conservative but dependent on transient checkout state.
- `hrc server tmux kill --help` still says “unclaimed” after the command learned to reap claimed orphans.
- `hrc resume --dry-run` omits the placement line emitted by run/start.
- Pre-existing: the worktree janitor opens the live daemon database through a migration-capable path even for `--dry-run`. The pattern predates this window and exists elsewhere; address repo-wide if changed.

## Risks and boundaries

### R8 — Production is on an unmerged branch behind main

At the frozen snapshot all 48 branch commits were unmerged, while the branch was five commits behind `origin/main`. The installed daemon runs that branch tip and therefore omits landed main work, including T-06931's CLI helper deduplication. A merge-tree probe found only a `bun.lock` content conflict, but no suite has run on the actual merged tree.

**Disposition:** merge/reconcile, regenerate the lockfile, and run the full bar on the merged result before treating it as the integrated release.

### R9 — Other-ref-only commits are duplicative, not lost

The six other-ref-only commits are content-equivalent to re-landed work. In particular, the T-05562 behavior was re-landed inside `3952456`. The stale remote backlog branch can be deleted after operator review.

### R10 — Actuator split is opt-in, not high-risk detection

`effectivePolicy()` reads `intent.execution.actuatorSplit`; HRC enforces a declared split but does not determine that an undeclared request is high-risk. This is a trust-boundary note, not classified by Clod as a defect.

## Live vs reviewed-only evidence

Verified live/read-only:

- Placement from four cwd locations across four targets; registry, marker-scan, and fail-closed paths.
- Detached-worktree placement tripwire and exact remediation wording.
- Lease socket estate: 80 claimed nonterminal lease sockets, zero orphans; 51 renderer-control sockets are a separate class.
- Installed release provenance.
- H1 selector matrix.

Reviewed but not exercised because it would mutate state:

- Destructive claimed-orphan reaping.
- `worktrees prune --yes`.
- Drained restart and lifecycle-scope refusals.
- Cross-node semantic-turn forwarding.

## All 42 task grades

| Task | Grade | Class | Evidence / note |
| --- | ---: | --- | --- |
| T-05113 | B+ | feature | Role tree and historical-generation collapse. |
| T-05177 | B+ | defect | Interactive reuse veto honored consumer-side. |
| T-05299 | B+ | defect | Reattach control proof; residual ASP hang tracked separately. |
| T-05337 | B | defect | Classifier sound; destructive acceptance unexercised; M3. |
| T-05439 | A- | feature | Declared policy fail-closed and anti-downgrade; see R10. |
| T-05562 | B+ | feature | Managed wrkq authority re-landed in `3952456`. |
| T-05577 | B | defect | Cross-repo ASP delivery, closure evidence only here. |
| T-05639 | B+ | defect | Structured unhandled-request error. |
| T-06005 | B+ | disposition | Reproduction supports no new guard. |
| T-06006 | B+ | defect | Busy-DM delivery age. |
| T-06007 | B+ | feature | Installed scope-refusal proof in closure. |
| T-06015 | B+ | defect | No-prompt broker-tmux admission. |
| T-06090 | B+ | defect | Sequence-gap tripwire and backfill. |
| T-06367 | A | umbrella | Ratified placement campaign; acceptance met. |
| T-06368 | A | feature | Project-origin plumbing. |
| T-06369 | A | defect | All three resolution paths live-proven; M2 interaction noted. |
| T-06370 | A | defect | Fail-closed and exact remediation live-proven. |
| T-06371 | A | test | Invariance matrix independently re-proven. |
| T-06405 | B+ | feature | Defensive janitor; M2/L5 gaps. |
| T-06457 | B+ | defect | Broker payload/status/exit semantics. |
| T-06566 | B | feature | Closure/gates reviewed, not directly exercised. |
| T-06576 | B | feature | Behavior sound; closure SHA typo M4. |
| T-06579 | C | feature | Thread behavior works; selector addressing broken H1. |
| T-06582 | A- | defect | Stress reproduction before deterministic fix. |
| T-06587 | B+ | defect | Root cause addressed; not live memory-profiled by Clod. |
| T-06588 | B | disposition | Regression pin and intended disposition. |
| T-06592 | B+ | defect | Durable acceptance stages and 202 contract. |
| T-06593 | A- | test | Previously vacuous branch now covered. |
| T-06719 | B+ | defect | Periodic timer directly observed. |
| T-06801 | B | disposition | Cross-repo architecture closure. |
| T-06802 | B | feature | Two completion cycles; collective history substrate. |
| T-06809 | B | feature | Additive federation contract; not driven cross-node. |
| T-06825 | B | operations | Registry/launchd evidence outside repo. |
| T-06830 | C | feature | Trace works but selector grammar diverges H1. |
| T-06846 | B+ | defect | Canonical runtime crash without invented provider facts. |
| T-06911 | A- | defect | Reopened fixture now owns shell. |
| T-06912 | A- | defect | Ambient-state removal. |
| T-06931 | B | refactor | Main-only helper deduplication. |
| T-06932 | B | refactor | Clean split; integration risk R8. |
| T-06947 | A- | defect | Additional ambient-state removals. |
| T-06958 | A | feature | Release tuple confirmed live. |
| T-06963 | A- | operations | Closure artifacts and hash chain. |

Distribution: A 6; A- 7; B+ 16; B 11; C 2; D 0; F 0.

## Closure and reachability assessment

- Every task has a final comment; nearly all cite a commit, gate results, and installed release.
- Zero evidence-free closures.
- One traceability defect: M4.
- No-code or out-of-repo closures are justified: T-06801, T-06825, T-06005, T-06588, and T-05577.
- Both reopened tasks have stronger evidence on the second closure.
- Expected unassociated commits: lockfile sync waves.
- `43c9538` is a cross-project case: an HRC commit associated with an agent-spaces record, so it cannot reconcile solely against the 42 hrc-runtime closures.

## Recommended actions

1. Reopen/file H1 selector unification.
2. File M2 detached-worktree visibility/cleanup.
3. Add a lease-GC liveness fact.
4. Correct T-06576's closure SHA.
5. Reconcile the audit branch with `origin/main` and run the merged tree.
6. Refresh the two stale help/preview strings.
