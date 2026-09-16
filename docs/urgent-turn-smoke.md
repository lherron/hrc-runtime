# Broker admission door smoke

Validate the four explicit HRC submission classes against an installed release.
Admission class is selected by the endpoint or CLI flag, never by a policy field.

## Preconditions

1. Install the certified commit and activate it through the campaign coordinator.
2. Warm one real `claude-code-tmux` seat and one real `codex-app-server` seat.
3. Record each runtime and invocation id, then read the whole invocation ledger;
   do not grade from a capture or an agent self-report.

## CLI matrix

Steer = send now; queue = send after (T-08533). A steer joins the running turn,
or starts one when none is running. Steer is the default door of `hrc turn`.

| Command | Door | Expected disposition |
|---|---|---|
| `hrc turn <target> 'idle steer'` | steer | `executed{turnId}`: the steer starts its own turn |
| `hrc turn <target> 'mid-turn note'` while busy | steer | `absorbed{turnId}` when the active turn is open; typed rejection when guarded |
| `hrc turn <target> --wait final 'note'` | steer + wait | waits for `executed` or `absorbed{turnId}` and THAT turn's terminal |
| `hrc turn <target> --queue 'idle enqueue'` | enqueue | `executed{turnId}` and its own terminal |
| `hrc turn <target> --queue 'boundary enqueue'` while busy | enqueue | `queue.enqueued`, then `executed{turnId}` at the boundary |
| `hrc turn <target> --queue --wait final 'guarded work'` | enqueue + guarded | waits for this submission's `executed{turnId}` and that turn's terminal |
| `hrc turn <target> --preempt 'operator takeover'` | preempt | interrupted active terminal, then the preempting submission's own turn |

`--steer` is accepted as a no-op alias of the default. `--ttl <duration>` is
accepted only with `--queue` or `--preempt`, and `--reply-to` only with
`--queue`. A target with no session row yet is born through the semantic
handoff, whose launch turn carries the body. A non-operator preempt must return
`authority-denied` and produce no `interrupt.*` record.

## Ledger proof

For a blocking enqueue, the whole-runtime ledger must contain this ordered
subsequence with one stable submission id and one identified turn id:

```text
admission.requested(queue)
admission.admitted
queue.enqueued
submission.executed{turnId}
turn.completed{turnId}
```

Rejected, expired, and cancelled submissions end at their typed disposition and
do not wait for a message or reply row. The canonical final text comes from the
identified turn projection.

For a kicker presentation, send an addressed `wrkc say` to an idle or busy
seat. The admission class the ledger must show is the one the seat's driver
advertises (T-08094, T-08533): `admission.requested(steer)` with
`origin.envelopeId` followed by `submission.absorbed` (busy) or
`submission.executed` (idle, the steer started the turn) on a steer-capable
seat, and `admission.requested(queue)` with a positive TTL followed by boundary
`submission.executed` on one without. A steer refused unwritten by a guarded
turn, authority or capability is followed on the next pass by
`admission.requested(queue)` for the same envelope, executed after that turn. Either way exactly ONE envelope rides that
submission, the wrkq receipt is written on the landing and not on the admission,
and no `preempt` admission appears for a queue-intent delivery.

Run the timing-dependent set—busy enqueue, guarded wait, and preempt—twice on
the same certified source commit. Across every scenario require zero
`capture.warning` records.
