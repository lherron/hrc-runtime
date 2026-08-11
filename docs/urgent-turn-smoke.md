# Urgent-turn smoke: queued vs steering DM delivery

Executable validation runbook for `hrcchat dm` delivery semantics against a
BUSY target. Validates both delivery classes on both broker routes
(T-07155 / T-07191 / T-07203, spec r7 daedalus-approved):

| | Queued (default) | Steer (`--steer`; `--urgent` is a deprecated alias) |
|---|---|---|
| **Headless broker** (codex-class) | defers until turn end; warning `queued_behind_busy_turn` | `admitted_into_active_turn` (admission proof) or typed failure |
| **Interactive broker** (claude-class) | queued to live harness; warning `queued_to_live_harness` (may surface mid-turn) | `presented_to_live_harness` (pane-write proof ONLY) or typed failure |

Contract under test: a steer reports an HONEST outcome — one of the three
success shapes below, each claiming exactly what its actuator proves — or
fails typed. It is NEVER silently downgraded to deferred delivery, and no
possibly-actuated order is ever reported as never-landed.

## The three success shapes

| Outcome | Proof level | Route |
|---|---|---|
| `admitted_into_active_turn` | broker admitted the input into the running turn (turn-identity carried by the codex app-server) | headless |
| `presented_to_live_harness` | the text was WRITTEN INTO THE PANE while the named run was active — the harness decides when it takes effect; **not admission proof** | interactive |
| `started_fresh_turn` | the target was idle by the time the broker acted; the order started (and is tracked as) its own turn | both |

## Preconditions

1. Current binaries installed (`just install`), daemon restarted on the commit
   under test (`hrc server restart --wait --reason ...`; never `--force` past a
   busy runtime without cause).
2. Two disposable task-scoped targets, one per route:
   headless/codex-class (e.g. `daedalus@<project>:T-XXXXX`) and
   interactive/claude-class (e.g. `clod@<project>:T-XXXXX`).
3. **Warm each scope first** — send one trivial DM and wait for its turn to
   complete before any busy-window test. Crossing DMs to a COLD scope used to
   mint duplicate runtimes (T-06313/T-07202); even with single-flight, a warm
   scope makes the busy window deterministic. Verify exactly one live runtime:
   `hrc runtime list --json | jq '[.[] | select(.hostSessionId=="<hsid>")] | length'` → 1

## The busy-window recipe (per target)

1. **Kickoff** — make the target busy for ~4 minutes:

   ```
   hrcchat dm <target> - <<'EOF'
   Busy-turn smoke: count from 1 to 25, running `sleep 10` in your shell
   between each number, printing each number. If any message reaches you WHILE
   counting, acknowledge it immediately, state the number you had reached,
   then continue to 25. Do not finish early.
   EOF
   ```

2. **Wait for busy** (handle-form selector; scope-ref form is rejected):

   ```
   hrc monitor wait '<agent>@<project>:<task>' --until busy --timeout 90s
   ```

3. **Steer test** — while counting is in flight:

   ```
   hrcchat dm <target> --steer - <<< 'STEER CHECK: acknowledge now, mid-count, with the number reached.'
   ```

4. **Queued fence** — immediately after, while still busy:

   ```
   hrcchat dm <target> - <<< 'Fence: this one should queue.'
   ```

## Expected results — steer

Headless target:

```
hrcchat: steer [admitted_into_active_turn]: admitted into the target's active turn (run run-…); no separate reply will follow
```

Interactive target:

```
hrcchat: steer [presented_to_live_harness]: written into the target's live session mid-turn (run run-…); the harness decides when it takes effect — this is not admission proof
```

Both exit 0 with NO `queued_*` warning. If the busy window closed first:

```
hrcchat: steer [started_fresh_turn]: target was idle; the order started its own turn
```

Typed failures (each legitimate only under its trigger; queueing is NEVER one):

| Typed failure | HTTP | Trigger |
|---|---|---|
| `urgent_delivery_unsupported` | 422 | ALLOWLISTED pre-actuation refusals only: live broker does not advertise `busyPolicies:["steer"]` (rotate the runtime), no broker endpoint on the runtime, `steer_not_supported` / `UnsupportedCapability` / `broker_runtime_not_active` |
| `urgent_delivery_race_lost` | 409 | the active turn ended around the request (including a turn that began and ended entirely inside the probe window); non-actuated — resend if still relevant |
| `urgent_delivery_ambiguous` | 503 | broker input timeout, or ANY failure not provably pre-actuation (e.g. a pane paste whose Enter failed) — whether the order was presented is unknown; do NOT blind-retry: the ledger replays the recorded outcome |

Durable readback (all must hold):

- Message record: `hrcchat show '#<seq>' --json` →
  `execution.state == "completed"` with `execution.runId == <the run cited by
  the outcome>` (admitted/presented), or `state == "started"` with the fresh
  run (started_fresh_turn).
- No new NON-TERMINAL run row for an admitted/presented steer (one terminal
  `cancelled` provisional row tagged `superseded_by_steer` is the expected
  audit artifact; it must appear in no response).
- Server log: `steer_class.headless_steer_admitted_into_active_turn` /
  `steer_class.interactive_steer_presented_to_live_harness` /
  `steer_class.started_fresh_turn` (plus `semantic_dm.busy_headless_steered`
  on the headless DM busy branch).
- `steer_contributions` row sealed (`admitted` / `presented` /
  `started_fresh`; never left `attempting`).
- Behavioral: the target acknowledges mid-count with the number reached
  (headless: guaranteed by admission; interactive: expected at the next
  tool-call boundary, but presentation-only — absence of a mid-count ack is
  not by itself a failure of the `presented` contract).

## Expected results — queued fence

Headless:

```
hrcchat: warning [queued_behind_busy_turn]: target is busy; delivery deferred until the active turn completes
```

Interactive:

```
hrcchat: warning [queued_to_live_harness]: target is busy; input queued to the live harness and may surface mid-turn or after the active turn completes
```

Durable readback: message state `accepted` with its OWN minted runId (the
deferred path is unchanged by steer work); after the turn drains, headless
delivery metadata shows real deferral (`queueAgeMs` ≈ remaining turn duration;
live reference: 292322ms). Interactive mid-turn surfacing is opportunistic
(tool-call boundaries only) — anyone needing preemption uses `--steer`.

## Anti-patterns this doc exists to catch

- **Exit-0-with-warning on a steer send** — the T-07191 bug class (live repro
  trailed its target's turn by 6m14s while reporting success).
- **Claiming admission from a pane write** — the r1 rejection: interactive
  steers are `presented`, never `admitted`.
- **Reporting an actuated order as refused** — the r2/r6 rejections: `started`
  is a success shape; only allowlisted pre-actuation refusals may say
  `unsupported`.
- **Grading from agent self-reports** — duplicate runtimes (T-07202) produced
  contradictory narratives from "the same" scope. Grade only from message
  records, run rows, steer_contributions, and server logs.
- **Testing against a cold scope** — see Preconditions #3.
- **Piping lifecycle commands through filters** — typed refusals launder to
  exit 0. Run them bare.

## Provenance

Headless route validated live 2026-08-11 (pre-rename): steer acked mid-count
at 2 by a busy daedalus scope, admitted into `run-529ade62`; fence deferred
292s. Interactive semantics landed with T-07203 (spec r7; six-rejection
daedalus verification loop). Re-run both columns of the matrix after any
change to broker input policy handling, the steer executors, or the drivers'
applySteerNow implementations.
