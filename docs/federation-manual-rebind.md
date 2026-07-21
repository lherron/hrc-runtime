# Manual fenced rebind

Use this procedure to move one established scope from an old home at epoch `E`
to a new home at epoch `E+1`. It is the only supported operation that changes
effective summon authority. Editing `[placement]` alone never moves an
established scope.

The procedure deliberately has two fail-closed gaps. After `REVOKE`, and again
after registry `CAS` but before `ACTIVATE`, the scope is summonable nowhere.
Never skip or reorder a step. Run every command with the same exact scope, old
home, old epoch, and new home.

## Before the fence

1. Inspect the binding and record its exact tuple:

   ```bash
   hrc target locate <scope> --json
   ```

   The authoritative record must name `<old-node>` at `<old-epoch>`. Stop on
   skew or ambiguity and investigate it; do not guess an epoch.

2. On the old home, terminate every live runtime for the scope. Preserve the
   old continuation unless the rebuild explicitly calls for dropping it:

   ```bash
   hrc runtime list --scope <scope> --json
   hrc runtime terminate <runtime-id> --no-drop-continuation \
     --reason manual-rebind --source operator
   ```

   Repeat the list until it contains no live runtime. An archived continuation
   may remain for audit, but it will be fenced from creating a successor after
   `REVOKE`.

   If the scope is claim-born, also release its old wrkq claim after the final
   runtime is drained. The new home must acquire a fresh node-bound claim; an
   old-home claim intentionally cannot be reused across the fence.

3. Optionally write a human handoff seed before shutting down the old runtime.
   The new-home session is fresh continuity; no continuation identifier is
   copied across nodes.

4. Edit the agent's source `agent-profile.toml` so the exact pin (or applicable
   placement policy) names the new home. An exact pin has this form:

   ```toml
   [placement]
   "<project>:<task>" = "<new-node>"
   ```

   Materialize the profile change on both homes before proceeding. The edit is
   declaration only; the fenced commands below change authority.

## Four-step authority sequence

The preparatory drain/profile work above is step 1 of the operator procedure.
The three mutation commands are steps 2–4.

### 2. REVOKE on the old home

```bash
hrc federation rebind revoke <scope> \
  --expected-home <old-node> \
  --expected-epoch <old-epoch> \
  --new-home <new-node>
```

Success reports `revoked-nowhere`. The exact old ledger row is retained in
`revoked` state for audit and retries. The old home now refuses every summon
path, including successor creation from an archived continuation. If any live
runtime remains, the command visibly refuses without changing the row.

### 3. CAS on the new home

```bash
hrc federation rebind cas <scope> \
  --expected-home <old-node> \
  --expected-epoch <old-epoch> \
  --new-home <new-node>
```

The new home first asks the old home to prove that the exact old row is
revoked. It then performs registry CAS
`(<old-node>, <old-epoch>) -> (<new-node>, <old-epoch>+1)`. Success reports
`registry-moved-activation-pending`. The registry record carries
`establishmentProvenance=rebind` and `priorHomeNodeId=<old-node>`, but the new
home still refuses summons until explicit activation.

### 4. ACTIVATE on the new home

```bash
hrc federation rebind activate <scope> \
  --expected-home <old-node> \
  --expected-epoch <old-epoch> \
  --new-home <new-node>
```

Activation requires the exact rebound registry tuple and no unexpected live
runtime. Success reports `active-new-home`. Start the scope with explicit fresh
continuity on the new home and supply the optional handoff seed as the first
turn:

```bash
hrc start <scope> --new-session
```

For a claim-born scope, this local dispatch reacquires the wrkq claim before it
mints the new session and stores the new claim credential beside that session.
It does not re-establish or bump the placement tuple. Federated bare addressing
and startup repair remain unable to reacquire claim authority; they fail with a
visible instruction to dispatch locally on the new home.

Do not reuse a continuation that may already exist on the new home from an
earlier placement.

## Verification

Run these checks on both homes:

```bash
hrc target locate <scope> --json
hrc runtime list --scope <scope> --all-nodes --json
```

The registry and new-home active ledger must name `<new-node>` at `E+1`; the
old ledger must remain revoked at `E`; and live runtimes, if started, must exist
only on the new home. New envelopes use the bumped epoch, so an envelope routed
with `E` is rejected as stale. Responses for requests accepted before the
rebind may still complete through their durable accepted-request record.

## Failure and retry states

| Visible state | Meaning | Safe action |
| --- | --- | --- |
| `old-home-live` | REVOKE found a live old-home runtime; authority is unchanged. | Drain it, then retry the same REVOKE. |
| `unchanged` | Wrong node, tuple mismatch, missing old peer, or old-home revocation not proved. | Inspect both `target locate` results; correct the input/configuration. Do not advance the epoch. |
| `revoked-nowhere` | Old ledger is fenced; registry is still old or CAS failed. | Restore peer/registry reachability and retry the same CAS on the new home. |
| `registry-moved-activation-pending` | Registry is at new `E+1`, but no new local authority exists. | Drain any unexpected new-home runtime and retry the same ACTIVATE. |
| `active-new-home` | Rebind converged. | Verify both homes, then start fresh continuity on the new home. |

Each successful step is idempotent. Retry with the original `E`; never change
the expected tuple to make a conflict disappear. Once REVOKE succeeds, ordinary
summon operations cannot roll the scope back to the old home. Restore failed
infrastructure and finish forward. A different destination requires first
completing this rebind, then executing a new fenced rebind from the resulting
tuple.

Structured logs retain `federation.rebind.revoke`,
`federation.rebind.cas`, and `federation.rebind.activate` with the tuple,
outcome, visible state, and retryability. Peer credentials are never logged.
