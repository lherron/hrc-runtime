# Agent Enablement Changelog

Append-only ledger of reusable agent-enablement lessons for hrc-runtime. One row per
substantial task, routing the primary lesson to exactly one carrier.

## Retro Cadence

After closing a **substantial** hrc-runtime task, the coordinator appends exactly one
row to the Ledger below, routing the task's primary reusable lesson to exactly one
carrier. Keep it terse and structural: a lesson, not a status summary.

- **Substantial** = a task that changes code behavior, public/process docs, checks,
  tools, skills, runtime behavior, or project operating rules. Typo-only edits do not
  need a row.
- **Carriers** (choose exactly one): `doc` . `rule` . `skill` . `tool` . `check` . `TACIT`.
  Composite carriers are invalid; pick the place where the lesson is actually enforced
  (regression tests are `check`; typed/parse-boundary code is `tool`; prose-only is `doc`).
- **landing** must be concrete: a file path, check/script/test name, skill name, command,
  or, for `TACIT`, a short reason plus a revisit condition.
- Append new rows at the bottom. Do not sort or rewrite history (typo fixes only).

## Ledger

| date | task | lesson | carrier | landing |
| --- | --- | --- | --- | --- |
| 2026-07-03 | T-05495 | Structural guards need a reviewed exception channel before they multiply; otherwise a local suppression can silently erase the guard set. | check | `scripts/check-suppressions.ts`, `.suppression-baseline.json`, `docs/suppression-policy.md` |
| 2026-07-03 | T-05499 | Boundary and manifest guards should teach the repair path when they fire, with FIX, WHY, and EXCEPTION text pinned by planted-negative tests. | check | `scripts/check-boundaries.test.ts`, `scripts/check-manifest-edges.test.ts` |
| 2026-07-03 | T-05516 | The lefthook commit/push gate is green but only enforced after `bun install` runs `prepare: lefthook install`; a fresh clone has `.git/hooks/*.sample` and no protection until then, so S6 enforcement is materialization-gated, not committed. | rule | `package.json` (`prepare`), `lefthook.yml`; run `bun install` on fresh clones |
| 2026-07-15 | T-06418 | Dependency pulls need a named owner; builds and installs must preserve the existing lock rather than pulling whatever was most recently published. | tool | `just pull-deps`, `just check-deps`, `scripts/lib/verdaccio-sync.ts` |
| 2026-07-21 | T-06631 | A sleeping peer is durable queue state, not an outage; operator projections should expose age and error while keeping replay idempotent and destructive drop limited to terminal rows. | tool | `hrc federation outbox`, `FederationOutboxRepository.dropDeadLetter` |
| 2026-07-21 | T-06632 | Cross-node read models stay trustworthy when fanout is bounded and concurrent, every answer carries its node and observation time, and unreachable peers retain only explicitly stale cached data. | tool | `hrc runtime list --all-nodes`, `federation/peer-observer.ts` |
