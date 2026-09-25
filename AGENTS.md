## hrc-runtime

The HRC (Harness Runtime Controller) layer of the three-repo split (ASP / HRC /
ACP): harness runtime lifecycle, event normalization, session/run state, and the
`hrc` / `hrcchat` CLIs. ASP packages are external deps from the canonical
Verdaccio registry at `http://mini:4873/`.

## Build & deploy

Read `~/praesidium/build_deploy_guide.md` before building, installing, or promoting anything in agent-spaces, hrc-runtime, or agent-control-plane. It is the agent digest of the published references `/a/hrc-build-deploy-guide` and `/a/asp-hrc-acp-dev-guide` on the taskboard. The rules that bite most: push before `just install` (a main-checkout install refuses an unpushed or non-clean tree; for a local install use `just install-dev`, which needs neither); install ≠ activate (`hrc server restart --reason …`, then read back `runningEqualsInstalled`); an HRC install before `just pull-deps` ships the OLD agent-spaces tuple — and so does one after a `pull-deps` that did not move `bun.lock`, so read back `git log -1 -- bun.lock` before installing; never `bun update`/`bun add` a synced package (`check-lock-coherence` refuses the split lock it leaves); fleet promotion is `just deploy-*` / `just fleet-status`, never by hand.

## Validation

- `bun run build` before `bun run typecheck` (TypeScript project references).
- Prefer live-code discovery over static prose: `bun scripts/find-entry-points.ts <topic>`, `bun scripts/explain-area.ts <file|dir>`.
- Isolated-daemon smoke: [docs/isolated-daemon-smoke-recipe.md](docs/isolated-daemon-smoke-recipe.md).
- Enablement lessons: [docs/agent-enablement-changelog.md](docs/agent-enablement-changelog.md#retro-cadence).
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
### Commands that answer confidently while checking nothing

The failure below has four shapes and they all read as a clean result. A probe
that cannot fail is worse than no probe, because it manufactures confidence: on
2026-09-06 all four turned up in a single day's work, twice producing a
"finding" that did not exist and once nearly stranding a landing. Before citing
any verification, ask what output it would produce if the thing being checked
were absent — if that output is indistinguishable from success, the check is not
one.

- **A missing key is not a null value.** `hrc server status --json` has no
  top-level `runningEqualsInstalled`; it lives at `.release.runningEqualsInstalled`
  and `.api.release.runningEqualsInstalled`. Querying the top level returns
  empty, which reads exactly like the daemon answering `null` — and got reported
  as a health-field bug that did not exist. Name the full path, and treat an
  empty answer as "wrong path" until you have proved the path is right.
- **`_` is a wildcard in SQL `LIKE`.** `LIKE '%submission_…_50%'` matched
  essentially every event on the runtime and returned 110 KB of noise that looked
  like data. Use `json_extract(col, '$.id') = '<literal>'` for an id.
- **A dirty-tree list is a snapshot of a tree several agents are mutating.**
  `just install`'s refusal is the authoritative read AT THE INSTANT IT RAN, and
  the tree moves underneath it — a reverted edit leaves no commit, so
  `git log -1 -- <path>` afterwards cannot see that the file was ever dirty and
  will contradict a correct report. Re-read when you act; never carry a snapshot
  into an attribution about who is holding what.
- **Never integrity-check a `cp` of the live state DB.** `state.sqlite` is
  WAL-mode and the daemon writes continuously, so a plain `cp` (even with the
  `-wal` sidecar) is a TORN copy: `PRAGMA integrity_check` on it returns dozens
  of `wrong # of entries in index` lines that say nothing about the real store.
  Snapshot with `sqlite3 -readonly <db> "VACUUM INTO '<snap>'"`, which is
  consistent and answers `ok`. Use the snapshot for migration dry runs too.
- **A piped `git push` tells you nothing about whether it worked.** `git push |
  tail -3` reports the exit code of `tail`, so a `! [remote rejected] … cannot
  lock ref` scrolls past and any `&& echo PUSHED` still fires. This repo is a
  SHARED worktree with several agents landing at once, so a lost push race is
  routine, not exotic. Capture the status: `git push > /tmp/push.log 2>&1; echo
  $?`, and confirm with `git status -sb` showing no `ahead` — an unpushed commit
  does not exist for anyone else.
- **`runtimes.updated_at` is a heartbeat.** Live runtime rows refresh it every
  ~5 s with no request in flight, so a before/after diff "changes" even when
  nothing touched the runtime. Prove "runtime untouched" by `status`,
  `active_invocation_id`, and `runtime_state_json.broker.brokerPid`.
- **A warmup count hides which brokers failed.** `broker.warmup.complete`
  reporting the same `attached`/`total` after a restart says nothing about
  whether the SAME runtimes are unreachable. Diff the `ipc_unreachable` runtime
  ids against the known set; a new id at an unchanged count is a regression.
- **The start response is not turn evidence.** On the headless route
  `hrc start --wait completed --json` returned `runtime.terminal: null` and no
  `finalMessage` for a turn that completed. Grade a turn from `hrc_events`: the
  final `turn.message` content and a `turn.completed` row for that `run_id`.

## Dependency Pins

The root `package.json` `overrides` block is the **pin table**: an exact version
there is the one version this workspace may resolve for that dependency.

- `bun run check:dependency-pins` (`just check`, lefthook pre-commit) refuses any
  manifest whose `dependencies`/`devDependencies` specifier disagrees with the
  table. `peerDependencies` stay free — a peer range describes the consumer's
  tree, not a resolution this workspace performs.
- `just doctor` (`bun run doctor`, `--check` to report only) prunes nested
  `<package>/node_modules/<dep>` copies of a pinned dependency whose version
  differs from the root resolution. It also runs inside
  `scripts/install-workspace-deps.ts` right after `bun install`.

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
admission labels) live in `agent-action-render`, consumed by `hrcchat-cli` and
gateway-discord through the RenderFrame contract.

The mail kicker is no longer in this repo. It is now `hrc-mail-injector` in
agent-control-plane (`packages/hrc-mail-injector`, `src/policy/`), running as its
own launchd job (`com.praesidium.hrc-mail-injector`). Read its log in
`var/logs/hrc-mail-injector.log` (`wrkq.kicker.*` events) and its private state,
including `hrcmail_birth_refusals`, `hrcmail_delivery_intents`, `hrcmail_presentations`
and `hrcmail_failure_notices`, in
`var/state/acp/hrc-mail-injector.sqlite` (`HRC_MAIL_INJECTOR_STATE_PATH`). The
`hrcmail_*` tables in HRC's `var/state/hrc/state.sqlite` are pre-split leftovers
with no writes since 2026-09-18. Reading them for current kicker state finds nothing.

## HRC Server Lifecycle

- Plist: `launchd/com.praesidium.hrc-server.plist` (canonical source) → `~/Library/LaunchAgents/`.
- Socket `var/run/hrc/hrc.sock`; state DB `var/state/hrc/state.sqlite`; logs `var/logs/hrc-server.{log,err.log}`.

**Use `just install-dev` for local installs.** It runs the same atomic build,
entrypoint smoke, and CLI cutover against the working tree as it stands — no push,
no clean-tree requirement, no `origin/main` containment — and publishes under the
`worktree` tag, so the `latest` channel other repos pull is untouched. `just
install` is the release path: use it when the commit is pushed and the install is
meant to be promoted to the fleet.

`just install` builds an immutable release away from the checkout and atomically
advances the shared `hrc` / `hrcchat` indirection only after build, entrypoint
smoke, and publication succeed ([docs/atomic-install.md](docs/atomic-install.md)).
`just install` refuses a worktree with tracked modifications before it builds
anything, listing the dirty paths; pass `allow-dirty=1` to install uncommitted
work deliberately.
**Install does not reload the daemon.** Build, publish, install, and restart are
separate states — record each. After runtime changes: `just install`, `hrc server
restart`, `hrc server status`; the readback must name the new release in
`binaryPath` / `packagePath`.

### aspd-prepared Codex route

Spec: [docs/aspd-headless-codex-integration.md](docs/aspd-headless-codex-integration.md).
With `HRC_ASPD_SOCKET` in the daemon's plist env, headless codex-app-server
prepares through the node's persistent aspd (launchd `com.praesidium.aspd`, ns
`~/praesidium/var/aspd`) and the worker runs from the frozen ASP release.

- **Opt-in per request.** Only `hrc start … --no-viewer` (headless, no viewer) or
  `--app-server-viewer` (headless with the attachable tmux renderer viewer) put a
  Codex start on this route. An omitted flag keeps max3's default, the
  interactive codex-tui redirect.
- **Two activations, never confused.** An HRC release activates by
  `just install` + `hrc server restart`. An ASP preparation release activates by
  `cd ~/praesidium/agent-spaces && just aspd-activate ~/praesidium/var/aspd
  <releaseId>` — no HRC restart. Read back both: `hrc server status --json` →
  `.api.aspd.release.releaseId`, and `just aspd-status ~/praesidium/var/aspd`
  (one aspd process, running == selected).
- **One active preparation release per node; bindings are permanent.** Live
  workers and never-submitted preparations stay on the release they were frozen
  to across activations. Retain retired releases; never GC a release a live
  worker or prepared operation references. A/B activation is a finite acceptance
  exercise, not a routing mode.
- **Attach, don't restart, a viewer.** `hrc attach <scope>` on a live
  `--app-server-viewer` runtime attaches to its `:tui` pane; detaching leaves the
  worker and renderer running.

## Fleet Deployment

Three logical nodes, each with its own checkouts, releases, and daemons: **svc**
on `mini` (user `lherron`), **max3** a separate workstation, and **hrcdev** a Tart
guest VM hosted on max3. (lab was retired 2026-09-22 and is no longer a deploy
target.) One recipe per node — `just deploy-svc`, `deploy-max3`, `deploy-hrcdev`
— plus `just fleet-status` for a read-only parity table and `just deploy-fleet`
to bring svc and hrcdev to max3 in a single pass.

**A node is three processes, deployed in dependency order**, each under its own
gui LaunchAgent and each with its own target:

| order | process | source | launchd label | proven by |
|---|---|---|---|---|
| 1 | aspd | throwaway detached worktree of `~/praesidium/agent-spaces` at the target → immutable release in `~/praesidium/var/aspd/releases` | `com.praesidium.aspd` | HRC's live probe `.api.aspd.release.sourceCommit` + a launchd-owned pid |
| 2 | hrc-server | this repo → atomic release | `com.praesidium.hrc-server` | `.release.hrcBuild.sourceCommit`, `runningEqualsInstalled`, launchd owns the pid with the plist env |
| 3 | hrc-mail-injector | `bunx hrc-mail-injector@<pinned>` from Verdaccio | `com.praesidium.hrc-mail-injector` | job pid argv names the pinned version, logged `"status":"running"`, same pid 10s later |

aspd goes first because HRC refuses every birth without a reachable aspd. The
injector goes last because it subscribes to the restarted daemon. aspd's
lifecycle is agent-spaces' own (`scripts/aspd-service.ts`: `supervise`,
`activate`; `just build-asp-release`, `install-asp-release`, `aspd-activate`);
the deploy lane only sequences it. The injector plist is rendered from
`launchd/com.praesidium.hrc-mail-injector.plist` by `just
install-mail-injector-launchd <version>`, which takes node ID and socket from HRC
status and the wrkq endpoint from the node's hrc-server plist, and retires any
earlier injector on this node's socket (ad-hoc `launchctl submit` jobs and loose
processes alike — two injectors are two mail writers). It needs the injector
state store to already carry its one-time kicker-store import marker.

**Unsupervised is the failure mode to watch.** On 2026-09-22 svc's aspd had died
days earlier as a detached `aspd-start` process: a stale socket and pid file
remained, HRC reported `aspd_unavailable`, the node could not birth, and the old
`fleet-status` still read healthy. `fleet-status` now prints `ASPD` from HRC's
live probe (`DOWN` when unreachable) and `INJECTOR` as the running pinned version,
`UNSUPERVISED` (a process serves this node's socket but not under its label), or
`down`.

**Targets are parameters, and `@max3` is the interesting default.**
`deploy-svc` / `deploy-hrcdev` default every target to `@max3`: what max3 is
*running right now* — hrc `.release.hrcBuild.sourceCommit`, aspd
`.api.aspd.release.sourceCommit`, and the injector version in its launchd job's
argv — read on the driver and handed to the node as literals. `deploy-max3`
defaults to `origin/main` (both repos) and `latest` (injector, resolved to a
version and pinned). Any ref works: `just deploy-svc origin/main origin/main
0.1.0-dev.…`. `deploy-fleet` resolves `@max3` **once** for both nodes; letting
each resolve it races a concurrent max3 install. Bring max3 to latest first, then
`deploy-fleet`.

**Restart mode.** Busy runtimes do not block a deploy — brokers reattach across
an HRC restart. `restart=wait` (default) drains in-flight runs first;
`restart=force` restarts through them and is the only mode that completes from a
live agent turn on the node being deployed.

**Cold-start check after a deploy.** "Cold start a :minisvc / :hrcdev clod" means
prove a fresh birth on that node answers mail. First make the seat cold: `hrc
target locate clod@hrc-runtime:<seat> --json` and read
`.peerResolution.location.observed.runtimes`. A `ready` runtime would be reused,
so if it has no active run, terminate it on its own node (ssh there, export PATH
first). Then send the probe through `wrkc say`, the only path that cold-births
a federated scope:

```bash
wrkc say --to clod@hrc-runtime:minisvc - <<'BODY'
Cold-start probe after fleet deploy <sha>. Reply to this envelope with: the node you are running on (`hrc server status --json | jq -r .node.nodeId`), that daemon's sourceCommit, and your cwd. Nothing else to do.
BODY
```

It passes only when the reply arrives and names the expected node and the
deployed sourceCommit. A queued envelope proves nothing.

Parity is measured in **sourceCommit, never setVersion** — every node's `just
install` / `build-asp-release` mints its own timestamped version or release ID
from the same commit. ASP *package* parity inside HRC follows from bun.lock at the
hrc target commit; the aspd *service* is a separate target.

Guards, all checked before anything moves (the agent-spaces checkout never moves —
aspd builds in a throwaway worktree at the exact target, so another agent's branch
there neither blocks nor is disturbed by a deploy; its target is still
containment-checked):

- **Containment** — the target must be contained by freshly fetched `origin/main`.
- **Direction** — the checkout must be at or behind the target. `--ff-only`
  cannot move backwards, so a checkout ahead of it would no-op and still report
  green. Going backwards is an operator decision.
- **Identity** — after the step, the running process must report the target
  commit/version. A restart onto a **stale** release looks exactly as healthy as a
  correct one; only the identity tells them apart.

Each step skips when its process already runs the target under its label, but its
identity assertion still runs.

`ssh <host> <cmd>` gets a non-interactive, non-login shell that reads only
`~/.zshenv`, and svc's does not add `~/.bun/bin` or Homebrew — `hrc` and `just`
are missing there. The recipes prepend the canonical locations rather than
requiring the dotfiles to agree.

**One bun, one place (T-08855).** Every node runs the official bun build in
`~/.bun/bin/{bun,bunx}` (bunx a symlink to bun), with no Homebrew or npm-global
copy anywhere on PATH. A block at the end of each node's `~/.zprofile` moves
`~/.bun/bin` to the front of the login PATH (`/etc/zprofile`'s path_helper
reorders what `.zshenv` set), because `zsh -lc` seats resolve bun that way. The
injector plist pins `~/.bun/bin/bunx` by absolute path, and so does any praesidium
LaunchAgent that execs bun directly. On 2026-09-23 max3's plist pinned an
npm-global bunx that was later uninstalled, and it would have died on its next
restart. `fleet-status` prints `BUN-LAYOUT`, which reads `canonical` or names the
stray copy or plist. Bump bun fleet-wide in one pass (same version and revision
on every node, `bun --revision`), never with a node-local `bun upgrade`.

**Supervisors.** Every node runs its three processes as console user `lherron`
under **gui LaunchAgents** in `gui/<uid>`. `hrc server restart` detects and
kickstarts the hrc-server job. Changing plist env = edit `EnvironmentVariables`
**and reload the job** (`launchctl bootout gui/<uid>/<label>`, then `bootstrap
gui/<uid> <plist>`) — `restart`/`kickstart` do NOT re-read the plist.

hrcdev's hrc-server job is **not** unsupervised: the claim that it ran with no
plist, orphaned to PID 1, was wrong and is what let T-07957 pass as a green deploy
over a detached daemon carrying none of the plist's environment. Until T-07958 it
also declared a second, root `/Library/LaunchDaemons` job for the same label; that
is retired (`.retired-T07958`). Its gui LaunchAgent carries
`VERDACCIO_REGISTRY=http://127.0.0.1:4873/`, the guest's only live
publish-containment guard, which daemon-spawned seats inherit. If a node ever
declares two jobs for one label again, pick one — `hrc server restart` refuses
to self-daemonize past an unloaded LaunchAgent (T-07957), so the deploy lane
stays red until it is resolved.

Env is read from `process.env` only: it lives in the node's plist
`EnvironmentVariables` and applies on the next supervisor (re)load. Never infer
launchd management from a plist's presence — a self-daemonized process orphans to
PID 1 identically. Check `launchctl print gui/<uid>/<label>` and whether the
running argv matches the plist's `ProgramArguments`.

### hrcdev — the Tart VM (max3)

**"hrcdev" in this repo always means the Tart macOS guest VM hosted on max3.** It
is a full logical node: roster id `hrcdev`, its own checkout at
`~/praesidium/hrc-runtime`, its own atomic releases, its own daemon, and its own
deploy recipe (`just deploy-hrcdev`).

Do not confuse it with the **`hrc-dev` lane** at
`~/praesidium/var/install/hrc-dev/tree`, which is a different thing with a
different repair procedure: a `git archive` export with no `.git` (so `git -C`
there silently resolves to the praesidium **root** repo and lies), no
`praesidium-release.json` (so it cannot state its own sourceCommit), and a
`KeepAlive` LaunchAgent `com.praesidium.hrc-dev` that must be stopped with
`launchctl bootout`, never `kickstart` or a kill. It has no deploy recipe and is
not a fleet node.

Tart macOS guest, `ssh hrcdev` (or `ssh lherron@192.168.50.45`). ssh timing out
while `tart list` says **running** means the vmnet bridge lost its uplink —
`ifconfig bridge100` shows `member: vmenet0` with no `member: en7`. It is not
tailscale and not guest sleep. Fix without restarting the guest: `sudo ifconfig
bridge100 addm en7` (macOS uses `addm`/`deletem`). LaunchAgent
`com.praesidium.hrcdev-vm-watchdog` (300s) auto-repairs; log
`var/logs/hrcdev-vm-watchdog.log`.

**Guest provisioning is not a copy of max3** — the guest was built credential-native
(T-07279/T-07281), so host-only conveniences are absent and host-only workarounds
linger. Two traps that cost real time:

- **Claude auth must be a real `claude auth login`, never `CLAUDE_CODE_OAUTH_TOKEN`.**
  Provisioning could not reach the login keychain over ssh, so it left a file-based
  `~/.claude/oauth-token` plus a `~/.local/bin/claude` zsh shim that exported
  `CLAUDE_CODE_OAUTH_TOKEN` before `exec`ing the real binary. ASP launch artifacts
  put that shim in `argv[0]`, so **every** harness session inherited a long-lived
  token — which Claude Code treats as inference-only, permanently breaking
  `/remote-control` ("requires a full-scope login token") no matter how often you
  re-run `claude auth login`. Retired 2026-08-24: shim replaced by a symlink to
  `~/.bun/bin/claude`, token file renamed `.disabled`. Auth now comes from
  `~/.claude/.credentials.json` like every other node. When diagnosing this class,
  note the var is **invisible to `env` inside the session** (Claude deletes it from
  `process.env` at startup) — read the exec env with `ps -Eww -p <pid>`, and check
  `argv[0]` in the launch artifact before suspecting the broker's env fence.
- **Do not pin interpreter minor versions in agent-home hooks.** max3 has
  `~/.local/bin/python3.12`; the guest has only `python3` (3.14). A
  `#!/usr/bin/env python3.12` shebang in the shared `defaults` hooks made every
  PostToolUse hook exit 127 on the guest. Shebangs in `var/agents/spaces/**/hooks`
  are fleet-wide — keep them at `python3`.

## Runtimes and Long Tool Calls

Headless runtimes run agents under a wrapper process (events via hooks + OTEL);
tmux runtimes drive a tmux pane and survive `hrc server restart`. On long tool
calls mind the zombie sweeper: 30 min of `hrc_events` silence
(`HRC_ZOMBIE_RUN_TIMEOUT_SECONDS = 1800`) marks the run zombie regardless of
process liveness.

After changing `hrcchat-cli` rendering, install and run a real round-trip through
a live `hrc-server` — unit tests don't catch terminal rendering regressions.

Federation doctrine is platform-wide; repo details in
[docs/federation-peer-protocol.md](docs/federation-peer-protocol.md).

## Consuming Published Dependencies (`just pull-deps`)

HRC consumes ASP (`agent-spaces`) **only** through published Verdaccio snapshots;
there is no source-level cross-repo import. **Editing `../agent-spaces` has zero
effect on HRC until it is published and pulled**, and the running daemon still
needs an HRC install plus restart.

- **Publish** (in `../agent-spaces`): `just install` publishes one coherent timestamped ASP set to mini's Verdaccio and, unless `no-sync=1`, syncs the local **hrc-runtime** checkout. HRC is the only consumer it syncs — see *ACP is not a sync target* below.
- **Pull** (here): `just pull-deps` verifies coherence, reconciles `bun.lock`, and creates one lockfile-only commit. `just check-deps` is advisory/read-only.

Gotchas worth not re-deriving:

- **Coherence guard.** `sync:asp` rejects a half-published snapshot — all ASP packages must share the same `latest`. No publishing/syncing one package in isolation.
- **Mini is the only registry authority** (`http://mini:4873/` must be reachable); svc and max3 use that store.
- **Pull != installed != live.** `just pull-deps` advances the lock; `just install` selects the release; `hrc server restart` activates it.
- **Compile dep vs runtime dep.** HRC code referencing new ASP *types/exports* needs the sync to typecheck — that serializes ASP→sync→HRC. A pure ASP *behavior* change flows through existing contracts, so HRC logic can be written in parallel and needs the sync only for runtime/e2e. Decide by whether the HRC diff names a new ASP symbol.
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
(plus dev/E2E packages) to Verdaccio for ACP. Publication is owned by repo
scripts (`just publish-dev[-dry-run]`; main-checkout `just install` publishes the
same coherent set) — do not hand-edit package manifests or publish individually.
