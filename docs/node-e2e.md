# Three-node HRC end-to-end protocol

This playbook records the three-node procedure proven during T-06805 on
2026-07-22. It is for federation, placement, summon, and directed-message tests
that must exercise real `hrc run` TUIs on all current logical nodes:

- `svc`: always-on ingress and binding-registry host.
- `lab`: isolated HRC node on the same Mac as `svc`, under the `lab` UNIX user.
- `max3`: workstation node reached over SSH; it may sleep.

The procedure uses Ghostty/ghostmux, installed HRC surfaces, live node state,
and durable readback. Command stdout by itself is never a verdict.

Related contracts:

- [Federation peer protocol](federation-peer-protocol.md)
- [Registry retirement](federation-registry-retirement.md)
- [State retention](state-retention.md)
- [Manual fenced rebind](federation-manual-rebind.md)

## The oracle quartet

Every delivery scenario is graded from four mutually reinforcing legs.

| Leg | Required evidence |
| --- | --- |
| Pane | Capture what the target or origin user actually saw in Ghostty. |
| Event | Read `turn.started`, `turn.completed`, and the expected runtime/node from `hrc monitor`. |
| Registry/ledger | Read the established tuple, epoch, retirement, or genuine unbound state with `hrc target locate`. |
| Round trip | Issue from the origin with `--wait response` or `--wait final` and prove the correlated reply returned to that origin. |

There is no one-way success row. A delivered ping must produce a deterministic
pong at the origin. A refusal must return promptly to the origin and must not
silently birth, route, or execute anywhere.

For a pre-runtime refusal, the event leg is a durable negative: record the
pre-case cursor, show zero target-scope events after it, and pair that absence
with the structured daemon refusal plus unbound/retired authority readback. An
event absence without a successful positive control is not evidence.

## Safety and test identity

Use a fresh, distinct scope for every case:

```text
<agent>@<project>:e2e-<case>-<run-number>
```

Before triggering the case, prove that a supposed virgin scope is actually
virgin on the relevant nodes:

```bash
hrc target locate cody@hrc-runtime:e2e-r1-1 --json \
  | jq '{scopeRef,localNodeId,gateMode,declared,ledger,registry,authority,observed}'
```

The required precondition is:

```text
ledger.state       = absent
registry.outcome   = unbound
authority.state    = unbound
observed.runtimes  = []
```

Never reuse a scope that was born and later terminated. Born identity is
durable; a terminated runtime does not make its ScopeRef virgin again.

Do not print `federation.json` while collecting evidence. It contains peer
credentials. Use `hrc server status --json`, `hrc doctor --json`, and
`hrc target locate ... --json`, which expose the required node and gate facts
without exposing tokens.

## Phase 0: make-or-break harness bring-up

If any node cannot be driven and captured, stop. Do not skip a node or replace
it with a mock.

### 1. Verify health and enforcement

From each node, confirm declared identity, peer reachability, and gate mode:

```bash
hrc server status --json | jq '{node:.node.nodeId,peerHealth}'
hrc target locate <fresh-scope> --json \
  | jq '{scopeRef,localNodeId,gateMode,declared,ledger,registry,authority}'
```

For a federation/summon test, `gateMode` must be `enforce`. A passing result in
`off` or `advisory` mode does not exercise the production refusal boundary.

Capture event high-water marks before opening the matrix:

```bash
svc_hwm=$(hrc monitor show --json | jq -r '.eventLog.highWaterSeq')
lab_hwm=$(ssh -o BatchMode=yes lab@localhost 'hrc monitor show --json' \
  | jq -r '.eventLog.highWaterSeq')
max3_hwm=$(ssh -o BatchMode=yes max3 'hrc monitor show --json' \
  | jq -r '.eventLog.highWaterSeq')
```

### 2. Wake and hold max3

First prove SSH and HRC health. Then keep a long-lived SSH process running:

```bash
ssh -o BatchMode=yes max3 'hrc server status --json'
ssh -o BatchMode=yes max3 'exec caffeinate -dimsu'
```

Run the `caffeinate` command in a managed long-lived terminal/exec session and
retain its process handle. Ending that SSH process releases the wake hold.

### 3. Open the three real surfaces

Always create a persistent shell surface and inject `hrc run` with
`send-keys`. Do not use `ghostmux new --command`; that window closes when the
command exits.

#### svc

```bash
svc_sid=$(ghostmux new --json --title 'node-e2e svc' \
  --cwd /Users/lherron/praesidium/hrc-runtime | jq -r '.id')

ghostmux send-keys -t "$svc_sid" \
  'hrc run cody@hrc-runtime:e2e-p0-svc-1'
```

#### lab: cross-user control

`lab` may not have its own GUI Ghostty session. The proven shape is a
ghostmux-controlled `svc` Ghostty surface whose persistent shell SSHes as the
`lab` user. The `hrc run` process itself uses lab's binary, socket, and state.

```bash
lab_sid=$(ghostmux new --json --title 'node-e2e lab' \
  --cwd /Users/lherron/praesidium/hrc-runtime | jq -r '.id')

ghostmux send-keys -t "$lab_sid" \
  "ssh -tt -o BatchMode=yes lab@localhost \
  'cd /Users/lab/praesidium/hrc-runtime && \
   exec /Users/lab/.bun/bin/hrc run cody@hrc-runtime:e2e-p0-lab-1'"
```

#### max3: remote-host control

Create and drive the surface through max3's own Ghostty API:

```bash
max3_sid=$(ssh -o BatchMode=yes max3 \
  "ghostmux new --json --title 'node-e2e max3' \
   --cwd /Users/lherron/praesidium/hrc-runtime" | jq -r '.id')

ssh -o BatchMode=yes max3 \
  "ghostmux send-keys -t '$max3_sid' \
   'hrc run cody@hrc-runtime:e2e-p0-max3-1'"
```

### 4. Prove send and capture on every node

Poll the panes for real TUI chrome such as the input rule or application frame.
Do not grep for the agent name; it appears in the echoed `hrc run` command and
causes false readiness.

```bash
ghostmux capture-pane -t "$svc_sid"
ghostmux capture-pane -t "$lab_sid"
ssh -o BatchMode=yes max3 "ghostmux capture-pane -t '$max3_sid'"
```

Once ready, inject a unique harmless response token and capture it:

```bash
ghostmux send-keys -t "$svc_sid" 'Reply with exactly: P0_SVC_PONG'
ghostmux send-keys -t "$lab_sid" 'Reply with exactly: P0_LAB_PONG'
ssh -o BatchMode=yes max3 \
  "ghostmux send-keys -t '$max3_sid' 'Reply with exactly: P0_MAX3_PONG'"
```

The `hrc run` bootstrap prompt can make the agent begin autonomous work before
the test prompt arrives. On the installed Codex surface, `Escape` interrupted
that active turn and returned to the input box. `C-c` exited the entire
`hrc run` session. Prefer `Escape` for a Codex turn interruption and verify the
pane afterward; reserve `C-c` for a test that intentionally validates session
exit/interrupt behavior.

### 5. Prove the round-trip primitive before the matrix

Choose an already-established, ready local TUI scope. Record its runtime and a
fresh event cursor:

```bash
hrc runtime list --scope cody@hrc-runtime:e2e-p0-svc-1 --json \
  | jq '[.[] | select(.status == "ready" or .status == "busy")] | last |
        {runtimeId,status,transport,controllerKind,scopeRef}'

roundtrip_hwm=$(hrc monitor show --json | jq -r '.eventLog.highWaterSeq')
```

From a separate origin shell:

```bash
hrcchat dm --wait response --timeout 2m --quiet --json \
  cody@hrc-runtime:e2e-p0-svc-1 \
  'Reply with exactly: P0_DM_PONG'
```

Require all of the following before proceeding:

1. Origin JSON says `status:"responded"`.
2. `sentMessageId` and `response.messageId` are present and correlated.
3. The response text is exactly the expected pong.
4. The target pane displays the incoming DM and reply.
5. The same runtime journals `turn.started`, `turn.message`, and
   `turn.completed`.
6. `target locate` still names the expected local home and epoch.

Prefer a runtime selector for event readback:

```bash
hrc monitor watch runtime:<runtime-id> \
  --from-seq "$roundtrip_hwm" --json
```

The installed monitor parser accepts canonical scope selectors such as
`scope:agent:cody:project:hrc-runtime:task:e2e-p0-svc-1`. It rejected
`scope:cody@hrc-runtime:e2e-p0-svc-1`; a target handle is not interchangeable
with a canonical ScopeRef in that selector position.

## Running a scenario

For every row:

1. Allocate a distinct virgin scope.
2. Record the origin and destination event cursors and relevant log line offsets.
3. Read placement policy and registry/ledger state before the request.
4. Run the request from a real origin surface.
5. Capture the origin and target panes.
6. Read target events from the recorded cursor.
7. Read registry/ledger state from the origin and designated home.
8. Prove the reply or typed refusal at the origin.
9. Check that no unexpected runtime appeared on any node.

For a hard absence proof, query each node directly. Do not assume a projection
is current when its peer is unreachable:

```bash
hrc runtime list --scope <scope> --json
ssh -o BatchMode=yes lab@localhost 'hrc runtime list --scope <scope> --json'
ssh -o BatchMode=yes max3 'hrc runtime list --scope <scope> --json'
```

`hrc target bindings --json` is a report object with `localNodeId`,
`federationConfigured`, `gateMode`, and `scan`; `jq length` counts those keys,
not bindings. Inspect its schema before writing projections around it.

### hrcchat DM example

Run this in a dedicated Ghostty origin shell and capture that pane:

```bash
hrcchat dm --wait response --timeout 30s --quiet --json \
  cody@hrc-runtime:e2e-r1-local-1 \
  'Reply with exactly: R1_PONG'
```

After a pre-runtime refusal, collect:

```bash
hrc monitor watch 'scope:agent:cody:project:hrc-runtime:task:e2e-r1-local-1' \
  --from-seq <pre-case-seq> --json

hrc target locate cody@hrc-runtime:e2e-r1-local-1 --json
```

Also read only the new structured daemon lines, filtering by the exact scope.
Do not dump the whole log; agent prompts and unrelated operations are noisy and
may contain sensitive context.

### ACP `/v1/inputs` example

First determine ACP's actual ingress HRC node rather than inferring it from the
host name:

```bash
acp server status --json
hrc server status --json | jq '{node:.node.nodeId,socketPath,dbPath:.api.dbPath}'
hrc target locate scribe@hrc-runtime:e2e-r3-acp-1 --json \
  | jq '{scopeRef,localNodeId,gateMode,declared,authority}'
```

Build the JSON on the controller and send one isolated curl command into the
origin pane:

```bash
r3_scope='agent:scribe:project:hrc-runtime:task:e2e-r3-acp-1'
r3_body=$(jq -nc --arg scope "$r3_scope" '{
  idempotencyKey:"node-e2e-r3-1",
  sessionRef:{scopeRef:$scope,laneRef:"main"},
  content:"Reply with exactly: R3_PONG",
  intent:{kind:"new_work"}
}')

ghostmux send-keys -t "$origin_sid" \
  "curl -sS -i --max-time 30 -H 'Content-Type: application/json' \
   --data-raw '$r3_body' http://127.0.0.1:18470/v1/inputs"
```

Do not append status-printing commands to this injected curl line. During
T-06805, an escaped separator became part of `/v1/inputs;`, producing a route
404 before admission. Keep the HTTP request isolated, capture its response,
and verify the exact `/v1/inputs` path in the ACP access log.

## Interpreting failures by seam

Two user surfaces can exhibit the same product defect at different internal
boundaries. The T-06805 RED run demonstrated this:

- `hrcchat dm` to a remote-designated virgin scope failed in the origin-outbox
  routing precheck with `binding_unbound` before summon.
- ACP `/v1/inputs` had already reached the summon gate and failed with an
  enforced `routed-elsewhere` refusal: the scope designated max3 while ingress
  was svc.

That distinction matters. A local-only bypass at the DM precheck would not fix
the ACP/taskboard path. Both surfaces require one placement decision seam and
the same authenticated remote-summon protocol behind the gate.

Also distinguish actionable HRC causes from the user-facing envelope. In the
RED run HRC produced `Summon it on max3`, while ACP returned a top-level HTTP
500/internal error. Preserve both artifacts; the flattening is independently
actionable error-surfacing evidence.

## Teardown

Teardown is part of the test, not optional cleanup.

### 1. Terminate runtimes and surfaces

Use explicit runtime IDs and preserve continuation unless the test requires
dropping it:

```bash
hrc runtime terminate <runtime-id> --no-drop-continuation \
  --reason node-e2e-teardown --source operator

ghostmux kill-surface -t "$svc_sid"
ghostmux kill-surface -t "$lab_sid"
ssh -o BatchMode=yes max3 "ghostmux kill-surface -t '$max3_sid'"
```

Terminating a TUI may close the SSH transport before its command prints a final
response. Always read runtime and surface inventories afterward; do not infer
teardown success from the SSH exit status alone.

Release the max3 wake hold by interrupting/closing the retained
`ssh ... caffeinate` process only after max3 readback is complete.

### 2. Preserve namespace truth

Never delete or purge a born binding. Registry tombstones, node-local epoch
fences, sessions, and terminated runtimes are keep-forever authority/history.
Purging them can make an ever-born identity appear virgin and permit an epoch-1
collision.

- A refusal scope that never birthed needs no authority mutation. Verify it is
  still unbound and has no runtime.
- A disposable policy-born harness scope must be terminally retired if the run
  requires a clean namespace afterward.
- Do not apply this terminal-retirement shortcut to a standing, claim-born, or
  child-born scope. Those require their owning authority and protocol.

Terminal retirement is fence-first:

1. Drain every live runtime for the exact scope.
2. Record the exact `(homeNodeId, placementEpoch)` tuple.
3. Dry-run a `NamespaceRetirementArtifact` through the repository's
   `applyNamespaceRetirements` API for the old-home state store.
4. Apply that artifact to archive the session and install the local terminal
   fence (`successorNodeId:null`).
5. Read the fence back from the old home.
6. Only then call `openBindingRegistry(...).retire(...)` on the authoritative
   registry with the same scope, home, epoch, timestamp, reason, and null
   successor.
7. Verify `authority.state:"retired"`, registry outcome `retired`, the exact
   epoch, and terminal-bar note from each relevant node.

Use repository APIs, never raw `UPDATE`/`DELETE` statements. The registry has no
general-purpose purge path by design. See
[Registry retirement](federation-registry-retirement.md) for the invariant and
[State retention](state-retention.md) for why the tombstone remains forever.

## T-06805 reference run

The 2026-07-22 Phase 0/1 run provides a known-good evidence shape:

- Initial high-water marks: svc `33289`, lab `1032`, max3 `1072778`.
- Send/capture surfaces: svc `A3B0ECAC...`, lab `098F8176...`, max3
  `F8AA063B...`.
- Established-scope control: request
  `msg-ba2b1d0b-7332-44ff-9bbe-e57e133c6c5b`, response
  `msg-ed8dda6d-045d-4957-9170-9fc6fc947a93`, runtime
  `rt-5dfbc919-6fc1-48bd-a6d3-ed7b8db00c02`, event range
  `turn.started` seq 33350 through `turn.completed` seq 33356.
- CLI RED rows remained unbound with zero target events and no runtime on any
  node.
- ACP ingress was svc while the virgin scribe scope designated max3.
- All Phase 0 harness scopes were terminally retired at epoch 1 after runtime
  and surface teardown. Refusal scopes remained genuinely unbound.

The complete run ledger is wrkq comment `C-11881` on T-06805. That run covered
Phase 0 and Phase 1 RED only. It did not execute or claim evidence for the
post-fix Phase 2 GREEN matrix.
