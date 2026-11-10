# 5. Placement and federation

Where a scope lives: the declared policy (agent profile `[placement]`), the established binding (local
ledger, then the svc registry) and the runtimes observed on this node; and the node's federation with its
peers. Native since 2026-10-26. Code: CLI `crates/hrc-cli/src/commands.rs` (`target locate|bindings`),
`crates/hrc-cli/src/local/doctor.rs` (renders only); daemon `server/projection/doctor.rs` (doctor rows, `GET
/v1/doctor`), `crates/hrc-native/src/server/placement/federation/`
(`locate.rs` for locate and the bindings scan, `projection.rs` for `--all-nodes`, `routing.rs`,
`peer_listener.rs`, `registry_listener.rs`, `retirement.rs`); config `crates/hrc-common/src/federation.rs`.
Docs:
`docs/federation-peer-protocol.md`, `docs/federation-registry-retirement.md`,
`docs/federation-binding-registry-rebuild.md`.

## Sub-features

- `~/.bun/bin/hrc target locate <scope> [--json] [--fail-on-skew]`: three truths, `declared` (`source` none,
  task-default with `nodeId`, or an exact pin), `authority` (bound|unbound, `source` ledger|registry),
  `observed` (`scope: local-node-only`, `nodeId`, `runtimeCount`, runtimes), plus `ledger`, `registry`
  (`not-consulted` when the local ledger is authoritative) and `designation` (2026-11-02, T-12291). Exit 0
  even with skew; 2 on an unparsable scope (`'not a scope!!'`, 2026-11-02, T-12291); 1 with `--fail-on-skew`
  and skew (source-only, 2026-11-02: commands.rs:61-77).
- `~/.bun/bin/hrc doctor` rows: `node-identity`, `federation-config`, one `federation-peer:<node>` per peer,
  `placement-skew` (bindings counted, disagreements), `placement-policy` (one warn per cause for live bindings,
  one `+` row counting dormant ones). Peer rows are back on native since a46bdc4f: the owner probes
  `/v1/status?includePeerHealth=true` (`.peerHealth[] {nodeId, state healthy|unreachable, checkedAt, answeredAt,
  latencyMs}`, also in `server status --json`, `[]` on a scratch) and logs one `federation.peer.probe` per peer
  per call. Live on 2026-11-09: node-identity `max3 (declared, federated, 2 peer(s))`, `+ federation-peer:svc`,
  `+ federation-peer:hrcdev`, 5450 bindings, `+ placement-policy (466 dormant …)` (T-12756). With a target
  doctor adds `target-lookup`, `target-health`, `dm-capability`, `runtime`; an unparsable one is
  `x target-resolve`, rc 1. Peer runtimes and a second health view live in `~/.bun/bin/hrc runtime list --all-nodes
  --json` `.nodes[] | {nodeId, state, latencyMs, detail}`: max3, svc and hrcdev `answered` twice on 2026-11-09.
  Each node entry also carries that node's full runtime list (193 MB of JSON on max3 on 2026-11-09, ~100 MB on
  11-02): always project with `jq`.
- `~/.bun/bin/hrc server status --json` `.node`: nodeId, nodeIdProvenance (declared|derived), mode, configPath,
  configExists, peerCount, peers.
- `~/.bun/bin/hrc target bindings [--json]`: the raw sweep behind doctor's skew/policy rows, keys `federationConfigured`,
  `gateMode`, `localNodeId`, `scan` (2026-11-02, T-12291); each `scan.unreadable[]` entry now has `live`
  (466 unreadable, 0 live on 2026-11-09), so the human `policy-unreadable:` count exceeds doctor's live warns. Single-flight, 20 s budget, a cut scan answers
  `scan.truncated {budgetMs, notAssessed, inFlightScopeRef}`, a slow one logs `federation.bindings.scan_slow`
  to `rusthrc-owner.log` (source-only, 2026-11-02: locate.rs:338-465; 13388 and 14323 ms at 08:35Z; 8092 and 5790 ms on 2026-11-09).
- Scope-homed reads are forwarded (T-10418): `/v1/events/tail` for `mable@hrc-runtime:minisvc` answered
  `x-hrc-home-node: svc`, this task's scope no header (2026-11-02, T-12291, `04-http-api`). The native session
  index is local only; the 30 s failed-peer skip (571c6c56) is Bun only (source-only, 2026-11-02:
  server/front/index.rs:1-27).
- `~/.bun/bin/hrc admin registrations gc` is gone (4c7c3653, T-11542): `/v1/registrations/gc` is 404 on native,
  `route.not_served` (2026-11-02, T-12291, `04-http-api`); the CLI was `unknown command`, rc 2 (2026-10-26).
- Not driven: `~/.bun/bin/hrc federation retire <scope>` (native CLI over `POST /v1/federation/retire`), the
  registry rebuild. Both are operator steps on a real scope.

## How to get to it

Live, read-only: `~/.bun/bin/hrc target locate …`, `~/.bun/bin/hrc doctor`, `~/.bun/bin/hrc server status --json`, `~/.bun/bin/hrc target bindings`. A
native scratch is the control case: no `federation.json` in its state root, so single-node with no TCP
listener: `hv run <name> -- ~/.bun/bin/hrc …`. Its derived nodeId is `max3`, the same string as live; tell them apart by
`.node.nodeIdProvenance` and `.node.configExists`, never by nodeId.

## Driving it

```bash
~/.bun/bin/hrc target locate clod@hrc-runtime:<task>          # declared/authority/ledger/registry/designation/observed
~/.bun/bin/hrc target locate mable@hrc-runtime:minisvc --json | jq -c '{authority, observed: (.observed|{nodeId,runtimeCount})}'
~/.bun/bin/hrc target locate mable@hrc-runtime:minisvc --fail-on-skew >/dev/null; echo "rc=$?"
~/.bun/bin/hrc doctor 2>&1 | grep -v '~ placement-policy'; ~/.bun/bin/hrc doctor 2>&1 | grep -c '~ placement-policy'
~/.bun/bin/hrc runtime list --all-nodes --json | jq -c '.nodes[]|{nodeId,state,latencyMs,detail}'   # peer health
~/.bun/bin/hrc target bindings --json | jq -c '{federationConfigured, gateMode, localNodeId, scan: (.scan|{scanned, skewed: (.skewed|length), unreadable: (.unreadable|length), truncated})}'
grep -F 'federation.bindings.scan_' ~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log | tail -2 | cut -c1-300
lsof -nP -a -p "$(~/.bun/bin/hrc server status --json | jq -r .pid)" -iTCP -sTCP:LISTEN   # live: the :18490 peer listener
hv run <name> -- ~/.bun/bin/hrc doctor
hv run <name> -- ~/.bun/bin/hrc server status --json | jq -c .node
```

## Gotchas

- **A remote-homed scope reads `observed.runtimeCount: 0` here and that is correct.** `mable@…:minisvc` is
  bound to svc; `observed` is this node only. Peers' runtimes are on `~/.bun/bin/hrc runtime list --all-nodes`, not in
  `locate`. Don't read 0 as "not running".
- **A single-node scratch never binds.** Native scratch `t-12291`: node-identity `max3 (derived, single-node, 0
  peer(s))`, federation-config `(absent, single-node mode)`, placement-skew `no placement bindings on this
  node`, `.node.configExists: false` (2026-11-02, T-12291, `01-server-health`); no inet socket on its pid
  while live listens on `:18490` (`00-guard`). Prove binding on live.
- Your own task scope binds on first birth while the profile declares no home: `clod@hrc-runtime:T-12291`
  read declared none, authority max3 `source: ledger`, designation `max3 (default_home_node(sender), epoch 1)`,
  1 runtime observed (2026-11-02, T-12291). That's not skew.
- **The 466 unreadable placement policies are registry data, not a native regression**, and since a46bdc4f they
  are all dormant, so doctor shows one `+` row, no warns (2026-11-09). Causes on 2026-11-02: 461 "project root
  unknown" (`~/.local/bin/wrkq projects` lists `strategy` with `root: null`), 2 safoundry root not canonical, 2
  ENOENT on a retired worktree, 1 ambiguous worktree; on 2026-11-09 "project root unknown for 177 project(s), 4
  other". The fix is `~/.local/bin/wrkq set`.
- The peer probe in `runtime list --all-nodes` times out at 1500 ms (projection.rs:21; ~2.05 s observed): the first call on 2026-11-02 08:59Z gave svc and
  hrcdev `unreachable`, `"probe timed out"`, `latencyMs` 2052/2051 (still listing their cached runtimes), and the
  next two calls seconds later gave all three `answered` (226/176 ms), while a routed read to svc answered 200 in
  0.47 s (T-12291 `05-placement-federation/drive.txt`). Read one `unreachable` as a probe timeout until a rerun
  agrees.
- `/v1/federation/health` is served only on the peer listener, not the unix socket (source-only, 2026-11-02:
  peer_listener.rs:203). `var/logs/hrc-runtime/hrc-server.log` is the Bun log, frozen 2026-10-26T15:37Z.

## Proven when

`target locate` shows your task scope bound in the ledger to max3 with a live runtime observed, a remote scope
bound to its home node with nothing observed here (its reads answering `x-hrc-home-node`), and
`--fail-on-skew` exits 0 where doctor's `placement-skew` reports no disagreement; `target bindings`
`scan.scanned` agrees with doctor's binding count (5450 = 5450 on 2026-11-09); doctor shows one `federation-peer:` row per peer; `runtime list
--all-nodes` shows every peer `answered` on a rerun; the scratch shows derived, single-node, no bindings, no TCP listener.

Driven 2026-11-09 (T-12756 upkeep, live read-only + native scratch, rusthrc release-20261108171912823-43877,
846648d8): `~/praesidium/var/wrkq-artifacts/T-12756/{05-placement-federation,04-http-api,01-server-health}`
(`--fail-on-skew` rc 0 on minisvc; bindings 5450 = doctor's 5450; peers `answered` twice; scratch `peerHealth []`,
no TCP listener). Not driven: `federation retire` (operator), the peer listener's `localOnly` 403 (needs a peer
bearer token).
