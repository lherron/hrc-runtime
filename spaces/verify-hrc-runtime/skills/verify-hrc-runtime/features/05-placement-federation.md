# 5. Placement and federation

Where a scope lives: the declared policy (agent profile `[placement]`), the established binding (local
ledger, then the svc registry) and the runtimes observed on this node; and the node's federation with its
peers. Code: `packages/hrc-cli/src/cli/handlers-federation.ts`, `register-federation.ts`,
`handlers-registration-gc.ts`; server `placement-federation-handlers.ts`, `placements-resolve.ts`,
`federation/`, `server-federation-startup.ts`, `registration-gc-handlers.ts`. Docs:
`docs/federation-peer-protocol.md`, `docs/federation-registry-retirement.md`,
`docs/federation-binding-registry-rebuild.md`.

## Sub-features

- `hrc target locate <scope> [--json] [--fail-on-skew]`: three truths. `declared` (`source` none,
  task-default with `nodeId`, or an exact pin), `authority` (`state` bound|unbound, `source` ledger|registry,
  `record.homeNodeId`, `isLocal`), `observed` (`scope: local-node-only`, `nodeId`, `runtimeCount`, runtimes).
  Exit 0 even with skew; 1 with `--fail-on-skew` and skew; 2 on usage.
- `hrc doctor` rows: `node-identity` (declared or derived, federated or single-node, peer count),
  `federation-config` (the `federation.json` path, or absent), `federation-peer:<node>` (healthy, latency),
  `placement-skew` (bindings counted, disagreements), `placement-policy` (unreadable declarations).
- `hrc server status --json` `.node`: nodeId, provenance, mode, peers with endpoints.
- `hrc target bindings [--json]`: the raw skew sweep doctor's `placement-skew`/`placement-policy` rows render
  (`federationConfigured`, `gateMode`, `localNodeId`, `scan.{scanned, skewed, unreadable}`), for scripting.
- `hrc admin registrations gc [--json]` with no scopes: the read-only retirement candidate projection
  (`candidates`, `lingerMs`). With scopes and `--yes` it retires: operator only.
- Not driven: `hrc federation retire <scope>` (permanent fence + binding delete), the registry rebuild.
  Both are operator steps on a real scope.

## How to get to it

Live, read-only: `hrc target locate …`, `hrc doctor`, `hrc server status --json`. A scratch is single-node
(`federation.json` absent), which is the control case: `hv run <task> -- hrc target locate …`.

## Driving it

```bash
hrc target locate clod@hrc-runtime:<task> --json | jq -c '{declared, authority, observed: (.observed|{scope,nodeId,runtimeCount})}'
hrc target locate mable@hrc-runtime:minisvc --json | jq -c '{declared, authority, observed: (.observed|{nodeId,runtimeCount})}'
hrc target locate mable@hrc-runtime:minisvc --fail-on-skew >/dev/null; echo "rc=$?"
hrc server status --json | jq -c .node
hrc doctor --json | jq -c '.[] | select(.name|test("node|federation|placement-skew"))'
hrc admin registrations gc --json
hrc target bindings --json | jq -c '{gateMode, localNodeId, scan: (.scan|{scanned, skewed: (.skewed|length), unreadable: (.unreadable|length)})}'
hv run <task> -- hrc target bindings --json | jq -c '{federationConfigured, gateMode, scanned: .scan.scanned}'
hv run <task> -- hrc target locate tabularasa@hrc-runtime:hvprobe --json | jq -c '{authority, observed: .observed.runtimeCount}'
```

## Gotchas

- **A remote-homed scope reads `observed.runtimeCount: 0` here and that is correct.** `mable@…:minisvc` is
  bound to svc (`source: registry`, `isLocal: false`); `observed` is this node only (peer observation is not
  built). Don't read 0 as "not running".
- **A single-node scratch never binds.** After a start, a send and a resume, the scratch scope still read
  `authority: {state: unbound}` with 2 runtimes observed (2026-10-05). Bindings are a federated-node
  behavior; prove binding on live.
- Your own task scope binds on first birth (`clod@hrc-runtime:T-10297`: `source: ledger`, `createdAt` the
  minute the seat was born) while the profile declares no home (`declared.source: none`); that's not skew.
- `/v1/federation/health` is not on the unix socket (feature 4); peer health comes from doctor.

## Proven when

`target locate` shows a local scope bound in the ledger with a live runtime observed, a remote scope bound
in the registry to its home node with nothing observed here, and `--fail-on-skew` exits 0 where doctor's
`placement-skew` reports no disagreement; `target bindings` counts the same bindings and unreadable
declarations as doctor (3537 and 7 on 2026-10-05, `gateMode: enforce`); doctor shows every peer healthy; the registrations projection
answers (empty `candidates` on 2026-10-05); the scratch shows single-node and unbound (`target bindings`: `federationConfigured: false`, `gateMode:
off`, `scanned: 0`).

Driven 2026-10-05 (T-10350 upkeep) on live max3 (installed 5bdb6c4e) and scratch `t-10350`:
`var/wrkq-artifacts/T-10350/05-placement-federation/drive.txt`.
