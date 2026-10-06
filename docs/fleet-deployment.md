# Fleet deployment

How HRC nodes are deployed and kept at parity: the three-process node, the
`just deploy-*` recipes and their guards, supervisors, and the hrcdev Tart VM.
Moved from the root `AGENTS.md`. The authoritative build/deploy digest is
`~/praesidium/build_deploy_guide.md`; daemon operation is in
[operations-runbook.md](operations-runbook.md).

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


## hrcdev — the Tart VM (max3)

**"hrcdev" in this repo always means the Tart macOS guest VM hosted on max3.** It
is a full logical node: roster id `hrcdev`, its own checkout at
`~/praesidium/hrc-runtime`, its own atomic releases, its own daemon, and its own
deploy recipe (`just deploy-hrcdev`).

The old **`hrc-dev` lane** (a `git archive` export at
`~/praesidium/var/install/hrc-dev/tree` run by LaunchAgent `com.praesidium.hrc-dev`)
was retired 2026-10-02 (T-10025 follow-up, Lance). Nothing should run HRC from it;
"hrcdev" only ever means the VM.

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

