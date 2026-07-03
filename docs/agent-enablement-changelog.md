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
