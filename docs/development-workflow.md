# Development workflow

Repo rules for changing hrc-runtime that every validation or dependency change
touches: which paths skip the code hooks, how specs amend records, how to find
code, the dependency pin table, the repo-split boundary, and how ASP comes in
and HRC goes out through Verdaccio. Moved from the root `AGENTS.md`. What fails
when each rule is broken: [rule-enforcers.md](rule-enforcers.md). Day-to-day commands:
[operations-runbook.md](operations-runbook.md).

## Validation scope

- Standalone HTML specs go in `docs/html/` (`just serve-docs`).
- `.hookignore` (gitignore syntax) lists the paths that cannot change what code
  validation proves — `docs/`, `architecture/`, and prose extensions. A change
  confined to them skips the lefthook code suites; anything else pays. The list
  is an explicit allowance, so a new top-level directory is code until someone
  adds it. `architecture-records` runs unconditionally because it is the only
  gate that grades `architecture/`.
- A spec change that moves a boundary must amend EVERY active record that states
  it. Grep `architecture/records/` for the old premise before submitting to
  Daedalus: the aspd route boundary lived in two invariants
  (`aspd-prepared-execution-release` and `asp-toolchain-selection`), and
  amending only one drew a rejection (T-08554 F1).

## Finding code

Prefer live-code discovery over static prose:
`bun scripts/find-entry-points.ts <topic>` ranks definitions and entry points
for a topic, and `bun scripts/explain-area.ts <file|dir>` prints an area's
layer, exports and import edges. Both read the TypeScript packages only; the
native owner lives in `crates/`, so search it with `rg` as well.

## Test entry points and timing

Run the full hrc-server suite from the repository root:

```sh
bun run test:integration > /tmp/hrc-server-suite.log 2>&1
```

This selects the package's hermetic runner, sets `TMPDIR=/tmp`, uses loopback
federation, and gives each test a 10-second default timeout. Bun writes test
results and its final summary to **stderr**; capturing stdout alone saves server
logs but loses the verdict.

| Entry point | Coverage |
| --- | --- |
| `bun run test:fast` | Script, unit, and contract tiers; excludes hrc-server |
| `bun run test:integration` | All hrc-server tests, including admission conformance |
| `just verify` | Architecture records, plus the cargo leg when Rust inputs changed; no Bun suites |
| `just verify-bun` | By hand, only for Bun/TS changes: ephemeral environment, structural checks, lint, typecheck, all test tiers, and the federation loopback corpus |

Bare `bun test` in the package bypasses the root's loopback switch and the
wrapper that cleans the environment **before** Bun starts. Without loopback,
federation fixtures use the available tailnet interface or skip cases that
require one. Loopback changes fixture transport, not production peer config.
The preload isolates in-process ledger reads, but cannot change what a child
spawned without an explicit environment inherits; use the wrapper to isolate
those children too.

For a slow suite, time each authored file independently:

```sh
bun run test:observability --root packages/hrc-server --retries 0 \
  --file-timeout-ms 120000 --output /tmp/hrc-server-timing.json
```

The timing runner uses the same hermetic startup environment, loopback
federation, and per-test timeout. It keeps both output streams in
`/tmp/hrc-server-timing.json.logs/`, updates the JSON after every file, writes a
Markdown summary, and prints a final pass/fail count. A file exceeding its
deadline has exit 124 and `timedOut: true`; its fixture process group is killed.
Dependency tests under `node_modules` are excluded. The worst-case test-process
budget is file count × file deadline × (retries + 1), plus discovery and report
writes. Individual-file timings do not detect interactions between files, so
also run the full integration tier.

The full suite starts over a thousand fixture daemons. A ten-minute aggregate
limit can expire while tests are still progressing; diagnose from file timing
and both output streams before treating that cutoff as a hung test.

## Dependency Pins

The root `package.json` `overrides` block is the **pin table**: an exact version
there is the one version this workspace may resolve for that dependency.

- `bun run check:dependency-pins` (`just check`, lefthook pre-commit) refuses any
  manifest whose `dependencies`/`devDependencies` specifier disagrees with the
  table. `peerDependencies` stay free — a peer range describes the consumer's
  tree, not a resolution this workspace performs.
- `just doctor` (`bun run doctor`, `--check` to report only) prunes nested
  `<package>/node_modules/<dep>` copies of a pinned dependency whose version
  differs from the root resolution. No recipe runs it for you: after a
  `bun install`, run `just doctor`, or install with
  `bun scripts/install-workspace-deps.ts`, which installs and then sweeps.

**Why both.** A floating specifier in a member manifest does not merely widen a
range: bun resolves it separately and installs a nested copy, and TypeScript
resolves types from the nearest `node_modules`, so that copy silently shadows
the root for that package alone while the lockfile still shows one clean
resolution and `bun install --frozen-lockfile` reports "no changes". The guard
stops new ones being declared; the doctor removes the ones already on disk,
which `bun install` never tidies on its own. Adding an exact pin to the table
extends both automatically (T-07695).

## Repo Boundaries

Enforced by `bun run check:boundaries`: HRC source **must not** import `acp-*`,
`gateway-discord`, `gateway-ios`, `coordination-substrate`, `wrkq-lib`, or
`wlearn`; it may import ASP packages by name (resolved via Verdaccio at install).

HRC source reaching an ACP-owned package — or either repo's tests asserting the
other's behavior — is a split violation: the assertion belongs in the other repo,
or the shared semantic belongs in `agent-action-render` / `hrc-frame-render` so
both sides test against it. Shared render semantics (tool emoji, action lines,
admission labels) live in `agent-action-render`, consumed by gateway-discord through
the RenderFrame contract.

## Consuming published dependencies (`just pull-deps`)

The pull-deps flow, coherence guard and compile-vs-runtime rule are in
[operations-runbook.md](operations-runbook.md#dependency-sync-asp--hrc). Two more:

- **Publish** (in `../agent-spaces`): `just install` publishes one coherent timestamped ASP set to mini's Verdaccio and, unless `no-sync=1`, syncs the local **hrc-runtime** checkout. HRC is the only consumer it syncs — see *ACP is not a sync target* below.
- **The sync spec is a hand-maintained list, and a new ASP dependency does not join it automatically.** `scripts/sync-asp-from-verdaccio.ts` enumerates the packages `pull-deps` advances. A direct dependency missing from that list is left behind while the rest of the set moves — and `pull-deps` still prints `ASP_SYNC ASP@<new>`, so the report is green while HRC's own ASP set is internally split. `agent-harness` and `spaces-harness-broker-pi-sdk` sat a release behind that way (T-07677). **When you add an ASP package to `package.json`, add it to that list in the same change**, and verify with: every ASP-family dep in `node_modules` reporting one identical version.

### ACP is not a sync target

agent-control-plane pins ASP and HRC as operator-managed *producer tuples* and
advances them only through its own governed `just advance-producers` inside a
coordinated deployment window. Its own
`docs/producer-advance.md` (in the agent-control-plane repo) names producer
`sync-downstream`, `just pull-deps`, routine `just install`, and a moving
`latest` tag as mechanisms that must never move that tuple — a producer's install
publishes a node-local set and moves `latest`, and that side effect is not a
release signal for ACP.

This cuts both ways for HRC. HRC publishes `hrc-core`/`hrc-sdk`/etc. for ACP (see
*Cross-Repo Publishing*), so **an HRC install is not an ACP release either**: ACP
picks HRC up only when an operator advances the `hrc` tuple. ACP running behind
the registry is the intended steady state, not staleness; the `PRODUCER_PINNED`
advisory lines exist so registry movement stays visible without changing the
deployed tuple. Never "fix" an ACP lag from this repo.

## Cross-Repo Publishing

HRC publishes `agent-action-render`, `hrc-core`, `hrc-sdk`, `hrc-frame-render`
(plus dev/E2E packages) to Verdaccio for ACP. `just publish [dry-run=1]` is
the canonical writer for the selected local release; `just install` itself
does not change the registry. Do not hand-edit package manifests or publish
individual packages.
