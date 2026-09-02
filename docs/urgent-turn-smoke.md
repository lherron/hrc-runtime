# Broker admission door smoke

Validate the four explicit HRC submission classes against an installed release.
Admission class is selected by the endpoint or CLI flag, never by a policy field.

## Preconditions

1. Install the certified commit and activate it through the campaign coordinator.
2. Warm one real `claude-code-tmux` seat and one real `codex-app-server` seat.
3. Record each runtime and invocation id, then read the whole invocation ledger;
   do not grade from a capture or an agent self-report.

## CLI matrix

| Command | Door | Expected disposition |
|---|---|---|
| `hrc turn <target> 'idle enqueue'` | enqueue | `executed{turnId}` and its own terminal |
| `hrc turn <target> 'boundary enqueue'` while busy | enqueue | `queue.enqueued`, then `executed{turnId}` at the boundary |
| `hrc turn <target> --steer 'mid-turn note'` while busy | steer | `absorbed{turnId}` when the active turn is open; typed rejection when guarded |
| `hrc turn <target> --wait final 'guarded work'` | enqueue + guarded | waits for this submission's `executed{turnId}` and that turn's terminal |
| `hrc turn <target> --preempt 'operator takeover'` | preempt | interrupted active terminal, then the preempting submission's own turn |

`--steer` and `--wait` are mutually exclusive. `--ttl <duration>` is accepted
only by enqueue and preempt. A non-operator preempt must return
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

For a kicker presentation, send an addressed `wrkc say` while the seat is busy.
The ledger must show `admission.requested(queue)` with `origin.envelopeId` and a
positive TTL, followed by boundary presentation. It must contain no steer or
preempt admission for that delivery.

Run the timing-dependent set—busy enqueue, guarded wait, and preempt—twice on
the same certified source commit. Across every scenario require zero
`capture.warning` records.
