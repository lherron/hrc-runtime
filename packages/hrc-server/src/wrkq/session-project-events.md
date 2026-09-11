# `session.*` project events

**Owner:** hrc-runtime. **Producer:** `session-project-events.ts` (hrc-server daemon).
**Envelope:** wrkq `wrkq.projectEvent.post` (wrkq T-08388, migration 000061).
**Introduced:** T-08389.

HRC knows every session it births and, until this, shared none of it. One
foreign project fact per birth puts *who was spawned, where, and why* onto a
project timeline a human already reads:

```
wrkp log hrc-runtime --type 'session.*'
```

wrkq owns the envelope. It validates syntax and a reserved-namespace list and
nothing else — it cannot tell a subject from a producer name and does not try,
so `hrc.session_started` would be **accepted and silently wrong**. This document
and code review are the only guards. The first segment of a type names the
**subject**, never the producer: `session.*`, not `hrc.*`.

## Types

| type | meaning |
| --- | --- |
| `session.born` | A fresh session: generation 1, no prior session. |
| `session.rotated` | A new generation of an existing seat (a successor, including the stale-generation auto-rotate). |

A rotation is a distinct fact, and a cheap one — 331 over the lifetime of the
ledger against ~89 births/day. A standing seat at generation 18 is exactly what
a reader debugging that seat wants on the timeline, so both are posted.

The two are separated structurally, not by reason string: a session row carrying
`priorHostSessionId`, or a generation above 1, is a rotation. There is no third
state, and no birth is published under both types — the rotation path appends a
single `session.created` for the successor, which this producer classifies once.

## Attributes

wrkq stores the attribute object's raw bytes and renders `key=value` pairs in
the **producer's key order**. That order is the only control this producer has
over what a human reads first, so the literal in `deriveSessionProjectEvent` is
the contract. **Do not sort it.**

| key | always? | value |
| --- | --- | --- |
| `source` | yes | `hrc-server` |
| `node` | yes | the daemon's federation node id |
| `seat` | yes | the **full** scope ref, suffixes and all |
| `agent` | when the scope names one | agent id |
| `cause` | yes | see below |
| `harness` | when the birth intent is known | `claude-code` \| `codex-cli` \| `pi-cli` \| `pi-sdk` \| `pi` \| `agent-sdk` \| `agent-harness` |
| `provider` | when the birth intent is known | `anthropic` \| `openai` |
| `mode` | when the birth intent is known | `headless` \| `interactive` \| `nonInteractive` |
| `session` | yes | host session id |
| `prior_session` | rotations only | the previous generation's host session id |
| `generation` | yes | stringified integer |
| `runtime` | yes | `harness` \| `command` |
| `requested_by` | when a task claim authority exists | the claiming principal |

Values are strings; numbers stringify. A value is clamped to 1024 bytes and a
summary to a single line of 512 — wrkq refuses beyond either, and a clamped row
beats no row.

`harness`, `provider` and `mode` come from the session's birth intent. A door
that creates a session without one (a bare `resolve-session`) publishes the
birth without them rather than guessing.

### `cause`

`cause` names the **door** a session came through, because that is what the
birth site can actually observe:

| value | door |
| --- | --- |
| `rotation` | a successor of an existing session |
| `summon` | the summon / ensure-target door |
| `dispatch` | a scope claim (`exact-scope-claim`, `roster-suffix-claim`) |
| `desktop` | Codex desktop registration |
| `command_run` | a command-scoped run |
| `resolve` | a bare `resolve-session` create |

Mail-driven and hand-driven summons are **both** `summon`: they are the same
door, and the birth site holds nothing that separates them. Likewise there is no
`cold birth` value — coldness is a property of the runtime that follows, not of
the row being written here.

### What is deliberately absent

`transport` (`tmux` / `sdk` / `headless` / `ghostty`) is **not** carried. No
runtime exists at the moment a session is born, so any value would be a
prediction of the transport rather than an observation of it, and a field that
cannot be wrong teaches readers to ignore the ones that can.

## Affiliation

A wrkq project event affiliates to a project, or to a task *within* a project —
never both at once, and a task it cannot resolve is a `NotFoundError` that stops
the INSERT.

HRC scope refs are `agent:<id>:project:<p>:task:<selector>`, and **the selector
is not necessarily a task id**. Measured over 6 days: 216 distinct T-shaped
selectors, **15 unresolvable** (~7%) — `:role:` probe suffixes
(`T-08199:role:parallel-alpha`), `-e2e` variants, malformed 4-digit ids
(`T-8151`), and ids purged from the ledger. Non-T selectors (`primary`,
`minisvc`, named lanes) are a further ~46% of births.

**The rule.** Attempt `--task` only for a canonical `T-\d{5}` with no suffix. On
*any* refusal, fall back to project-only. The full selector always survives in
`seat`. **A birth is never dropped because its scope names a task wrkq cannot
resolve.**

`project` and `task` are never sent together: wrkq refuses the pair with
`task_not_in_project` when they disagree, and this producer cannot prove they
agree. A task-affiliated post inherits its project from the task.

**The consequence, stated plainly.** Task affiliation is present iff wrkq
resolved the selector at post time **and** the task still exists — `task_uuid`
is `ON DELETE SET NULL`, so a later purge strips it too. A reader running
`wrkp log --task T-08198` will not see the `:role:` probe births thread under
it; `wrkp log <project> --type 'session.*'` shows every one.

A scope ref with no `:project:` segment has no project timeline to land on and
is dropped before the post, not sent and refused.

## Idempotency

The key is the **host session id**, which is unique per birth. Retries of the
same birth collapse onto one row; a rotation is a different host session id and
never collapses onto its prior. Replay returns the same uuid with
`created: false` and does **not** overwrite the stored attributes.

## Stability promise

- The two type names are stable. A new `session.*` type may be added; an
  existing one is never repurposed or renamed.
- A listed attribute key is never renamed or given a different meaning. A key
  may be added — consumers must tolerate unknown keys — and a key marked
  "when …" may be absent.
- The `cause` vocabulary may gain values as HRC gains doors. A consumer must
  treat an unrecognised `cause` as "some other door", not as an error.
- Key order may change only to improve what a human reads first. Consumers must
  key off names, never position.

## Failure posture

Publication is an **observation** of a birth that is already durable in the HRC
ledger, made on a detached promise after the write. A wrkq refusal, an
unavailable daemon, or a missing project is a missing timeline row and a
`session_project_event.post_failed` server log line — never a failed birth.

## Who may publish

`hrc server serve` is the only caller that passes a real `wrkqLedger`; every
other `createHrcServer` gets `UnreachableWrkqLedger` and posts nothing.

This is not incidental. An in-process server resolves the same wrkq locator as
the node's daemon — the ledger's address lives in the environment, not in the
runtime and state roots a test isolates — so before the default was inverted,
running the suite wrote 25 fabricated `session.born` rows into the live
`hrc-runtime` timeline under fixture agent names. A producer that turns every
session birth into shared-state writes makes that latent exposure load-bearing,
so reaching the fleet ledger has to be deliberate.
