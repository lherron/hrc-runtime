---
name: verify-hrc-runtime
description: Launch, check, drive and prove any HRC runtime feature (server health, runtime lifecycle, turns and monitor, the HTTP API, placement and federation, install and release, maintenance, attach) against the installed build, with evidence that survives. Use when changing, operating, debugging or grading hrc-runtime, or before claiming an HRC change works.
---

# verify-hrc-runtime

An HRC claim is proven by driving the installed `hrc` and its daemon and keeping the evidence. This skill
gives the one way to do that. [features/README.md](features/README.md) maps the eight features; each feature
file tells you how to reach the feature, drive it, what bites, and what "proven" looks like.

Only the hrc-runtime project composes this skill: `asp-targets.toml` in the hrc-runtime repo merges it into
clod, cody and the foundry resident when they run in project hrc-runtime.

## Launch

Scratch or live:

- **Scratch (the default for anything that writes).** `hv scratch up --name <task>` copies the installed
  release to `/tmp/hv/<name>/release`, has the copy's Bun store create a private `state.sqlite` (only Bun
  migrates; `rusthrc` refuses a missing store or a foreign migration set), and starts the copy's
  `bin/rusthrc server serve` (the production owner) on its own runtime and state roots (`/tmp/hv/<name>/run`,
  `/tmp/hv/<name>/state`) and its own wrkq store (`/tmp/hv/<name>/wrkq`), in a fresh ghostmux tab, and waits
  until it answers `server status`. `--engine bun` starts the retained Bun daemon from the same copy instead
  (dev-env, migrations); grade it only for a Bun-only claim. Run every `hrc` verb against it with
  `hv run <name> -- ~/.bun/bin/hrc …`. It is a real daemon with a fresh store: it births real harness runtimes (through
  the live aspd, which only prepares), and it never touches the live `state.sqlite`, ledger, ACP webhook or
  federation. Use it for starts, turns, sends, terminates, resumes, sweeps, captures and the HTTP API.
  - **Never run a daemon from the installed or owner tree.** A Bun daemon whose package sits in a release
    under `hrc-runtime-releases` reports `release.mode: atomic` and prunes that tree when it starts; one
    started that way deleted production's running release on 2026-10-26 (04:50Z, EN-36056). `rusthrc`
    prunes nothing, but from a production tree it pins itself to that release. The copy reports `unmanaged`
    (`releaseId` null in status; `hv scratch up` prints `engine`, `binaryPath`, `copyOf` and `sourceCommit`),
    `hv` refuses a root that names `hrc-runtime-releases`/`hrc-owner` or a copy carrying an
    `hrc-runtime-current` link, and it stops and refuses `atomic_release` if status ever says `atomic`. Record
    both release trees before and after a pass (`ls ~/.bun/install/hrc-runtime-releases/` and
    `ls ~/praesidium/var/hrc-owner/hrc-runtime-releases/`); neither may change.
  - The launcher drops every inherited `HARNESS*`, `TMUX*`, `HRC_*`, `AGENT*`, `ASP_*`, `CLAUDE*`, `CODEX*`,
    `WRKQ*` and `XPC_SERVICE_NAME` variable and sets `HRC_LAUNCHD_LABEL=hv.scratch.<name>` before it sets its
    own. Its daemon PATH prepends `~/.local/bin` and `~/.bun/bin` for internal owner clients; the
    calling shell keeps its filtered PATH. No child reaches the caller's broker, tmux server, the live ledger or the production launchd job (a
    native daemon whose `XPC_SERVICE_NAME` equals its label answers a granted stop with `launchctl bootout` of
    that job). `HRC_WRKQ_DB` is the only thing keeping a native daemon's `server.started` and session facts out
    of the live wrkq; the posts fail against the empty private store
    (`server_project_event.post_failed`, `session_project_event.post_failed` in `serve.log`), which is the
    isolation working. The runtime config path is `/tmp/hv/<name>/state/federation.json`, not a repo file;
    `hv scratch up` does not create it, and the launcher scrubs any inherited `HRC_PEER_CONFIG_FILE` override.
    With that config absent the scratch is single-node (derived nodeId `max3`, the same as live: tell them
    apart by `.node.nodeIdProvenance` and `.node.configExists`).
  - Birth the blank agent `tabularasa@hrc-runtime:<slug>` (claude via `claude-hrcpty`, no spaces) with a
    one-word prompt ("Reply with exactly the word OK and nothing else. No tools."). Each turn is a real model
    call. Its seat runs under `hrc-pty`, not tmux (features 2 and 8).
  - The daemon runs in a ghostmux tab to keep it out of your harness's environment. `rusthrc server serve`
    has no harness guard (feature 1); the scrub is what keeps a scratch's births clean. Don't unset your own
    shell's variables to start one by hand; use `hv`.
- **Live (read-only).** The launchd daemon (`com.praesidium.hrc-server`, socket
  `~/praesidium/var/run/hrc/hrc.sock`). On it run `~/.bun/bin/hrc server status`, `~/.bun/bin/hrc doctor`, `~/.bun/bin/hrc target locate`,
  `~/.bun/bin/hrc monitor show|watch|events|transcript|stats|search`, `~/.bun/bin/hrc runtime list|inspect|diagnostics`,
  `~/.bun/bin/hrc admin metrics report|routes`, `~/.bun/bin/hrc target bindings` and dry-run `admin runs`. Its log is
  `~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log` (JSON lines `{ts, server:"rusthrc", level, component,
  event, data}`); `hrc-server.log` there is the Bun owner's, frozen at 2026-10-26T15:37Z. Use live when the claim is about the installed node itself: its release, its federation, its
  bindings.
- **Never** restart or stop the live daemon (`~/.bun/bin/hrc server restart|stop`), run `just install`, publish, deploy
  or retire on live from this skill. Those belong to Mable primary (restart) and the install doctrine
  (`~/praesidium/build_deploy_guide.md`). When a drive needs one, write the step down, mark it
  `needs operator`, and drive what you can around it.
- Test **what is installed.** `hv` runs the installed `hrc` CLI (`~/.bun/bin/hrc` → the current release's
  `bin/rusthrc`, the native CLI) and a byte copy of that release as the scratch daemon, not the checkout. A
  change is not testable here until it is installed; until then say so. Since 2026-10-26 production is native
  on both sides: the live daemon is `rusthrc server serve` from the owner tree
  (`~/praesidium/var/hrc-owner/hrc-runtime-current`) and the CLI is `rusthrc`. Some CLI verbs still hand off to
  the retained Bun CLI (`crates/hrc-cli/command-scope.json` entries marked `bun` exec `bun
  <release>/packages/hrc-cli/bin/hrc.js`: every bare group and its `--help` (so `~/.bun/bin/hrc admin --help` is
  commander output), `monitor search`, `runtime send`, `session meta set|clear`, `session retitle`, `server tmux
  kill`, `capture release|recover`, `admin broker-verify run`, `admin runs recover-unstarted`, `admin worktrees
  prune`, `admin runtime ensure|prune`, `admin surface list|unbind`, `admin events`, `federation retire`,
  `index status|rebuild`, `run annotate|export`); they talk to the same native daemon, which has no Bun
  fallback, so a Bun verb whose route native never ported answers 404 (`route.not_served` in the serve log). Say which engine you graded: a drive on `--engine bun` proves nothing about production. To tell
  which daemon answered a socket read, read the serve log's `server.listening` line (`owner: "rusthrc"`) or the
  per-request `http.request … servedBy: "native"`; `.api.listenSocketPath == .api.socketPath` is hard-coded
  on native and proves nothing (feature 1).

## Doctor

Always start with `~/.bun/bin/hrc doctor` (read-only) and `~/.bun/bin/hrc server status`, and run them again after anything
surprising. On a scratch: `hv run <name> -- ~/.bun/bin/hrc doctor`.

```bash
~/.bun/bin/hrc doctor                         # + ok, ~ warn, x fail; exit 0 unless a fail (--strict: warns too)
~/.bun/bin/hrc server status --json | jq '.release | {mode, releaseId, runningEqualsInstalled, src: .hrcBuild.sourceCommit}'
hv run t-xxxxx -- ~/.bun/bin/hrc doctor       # scratch: single-node, no bindings
```

On max3 `~/.bun/bin/hrc doctor` prints `~ placement-policy` warns for task scopes whose worktree is gone or ambiguous.
Those are normal and are not a reason to stop; `--strict` turns them into exit 1. Every `~/.bun/bin/hrc server status
--json` path is nested (`.release.runningEqualsInstalled`, `.node.nodeId`); a top-level read answers `null`
for a path that doesn't exist. `~/.bun/bin/hrc info` lists the paths.

## Drive

1. Find the feature in [features/README.md](features/README.md) and read its file.
2. Doctor.
3. Drive it with `hv` and `hrc`, as the file's "Driving it" shows, recording each step with
   `hv rec <artifact_dir>/NN-<feature>/drive.txt '<command>'` as you go ("Evidence" below).
4. Check the file's "Proven when" against what you captured.
5. If the drive disagreed with the file, fix the file (Gotchas, with date and evidence) in the same change.

`~/.bun/bin/hrc --help` (agent view), `~/.bun/bin/hrc --human --help`, `~/.bun/bin/hrc admin --help` (the full cellar), `~/.bun/bin/hrc info` and
`~/.bun/bin/hrc <cmd> --help` give the live surface. `docs/cli-surface.md` and `docs/cli-reference.md` describe it.

## Evidence

- **The installed surface, not a unit test.** A claim is proven by the installed build driven end to end and
  observed in its own outputs: `~/.bun/bin/hrc server status --json`, `~/.bun/bin/hrc monitor` (the lifecycle log and the
  invocation ledger), `hrc_events`, the pane (`~/.bun/bin/hrc peek`, ghostmux capture), the HTTP responses.
- **Grade a turn from the ledger, not the start response.** `~/.bun/bin/hrc start --json` answers at `accepted`; the
  turn's proof is `turn.completed` for its `runId` and the final `turn.message` (`~/.bun/bin/hrc monitor watch`,
  `~/.bun/bin/hrc monitor transcript`), or the `terminal.finalMessage` of `~/.bun/bin/hrc turn --wait final` on a warm seat (on a cold
  scope `--json` prints `render_frame` lines instead; feature 3 Gotchas).
- **An artifact that survives,** under your task's `artifact_dir` (`~/praesidium/var/wrkq-artifacts/<task>/`),
  in one layout:
  - `NN-<feature>/drive.txt` per feature, written by `hv rec`: a `## <UTC time>` line, `$ <command>`, its
    output and `exit <code>`, so the file reruns as written;
  - `evidence/<scratch name>/` per scratch, from `hv evidence <name> <artifact_dir>/evidence/<name>` before
    `hv scratch down` (`serve.log`, status, runtimes, sessions and an `hrc_events` dump). One scratch usually
    serves several features;
  - `live/` (or the feature's drive.txt) for reads against the live daemon.

  Never put evidence inside the scratch root, which `down` removes; `hv evidence` refuses that.
- **Repeatable.** Someone else can rerun `<artifact_dir>/NN-<feature>/drive.txt` on a fresh
  `hv scratch up` and see the same end state. Runtime ids differ per birth; read them from the start output.
- **Reproduce before you fix.** For a defect, capture the failing drive first. If you can't reproduce it,
  say so and show what you ran.
- **Name what you couldn't drive,** and the concrete prerequisite that stopped you (for example `needs
  operator: just install` or `needs operator: ~/.bun/bin/hrc server restart`).
- **Prove a negative with a discriminator.** A command that answers the same whether the thing is there or
  not proves nothing (`jq` on a missing key is `null`; `turn-finished` armed after the turn exits 20 on
  timeout, not "never finished"). Show the control case beside the subject.

## Cleanup

`hv scratch down <name>` terminates every non-terminated runtime on the scratch, stops the daemon it
started (SIGTERM, then SIGKILL after 5 s), closes its ghostmux tab and removes `run/`, `state/`, the release
copy and the wrkq store. It keeps
the daemon's log (serve.log), the launcher script hv wrote for it and its start time (up_at) in
`/tmp/hv/<name>/` for a post-mortem; they are scratch files, not repo paths. A terminated harness can still
name `/tmp/hv/<name>` for a few seconds after `down` returns (a resumed claude for ~3 s on 2026-10-05,
T-10350; one process still at +5 s and none at +20 s on 2026-10-19, T-11363; one, gone before it could be listed,
at ~+20 s and none at ~+30 s after a native hrcpty scratch on 2026-11-02, T-12291), so recheck before calling the
scratch clean. `--dry-run` prints the plan
first. `hv scratch list` shows what is up. Close any other ghostmux tab you opened
(`ghostmux kill-surface -t <id> --force`) and confirm no process still names the scratch:
`ps -axo pid,command | grep -c '/tmp/hv/<nam[e]>'` (0 when clean). Bracket one character so the grep doesn't
count itself, and keep the plain path out of the rest of that command line: `hv rec` runs it under `bash -c`,
whose argv is in `ps` too. On 2026-10-19 a check recorded in the same `hv rec` as `HV_HOME=<root> hv scratch
down` counted 4 processes that were only the probe itself; alone, it counted 0 (T-11363).

## Maintain

The upkeep pass keeps this skill true: index hygiene, one source read per feature, a drive of every
feature, triage (doc drift, harness gap, product gap), at most one commit, and a `verify.upkeep` fact at the
end. The procedure is [MAINTAIN.md](MAINTAIN.md).

## Helpers

`hv` (in this directory) is the one helper. Every verb except `run` and `rec` prints one JSON object; a
refusal prints `{error, message, next}` and exits 1. Put it on your path or call it by its path:
`~/praesidium/hrc-runtime/spaces/verify-hrc-runtime/skills/verify-hrc-runtime/hv`.

| Verb | Invocation | Does |
| --- | --- | --- |
| `scratch up` | `hv scratch up [--name N] [--engine native\|bun]` | Copies the installed release to `/tmp/hv/N/release`, migrates a private wrkq store in `/tmp/hv/N/wrkq`, and in a new ghostmux tab with a scrubbed environment either (native, the default) creates `/tmp/hv/N/state/state.sqlite` with the copy's Bun `openHrcDatabase` and execs `<copy>/bin/rusthrc server serve`, or (bun) execs `bun <copy>/packages/hrc-cli/src/cli.ts server serve`, on `/tmp/hv/N/{run,state}`; waits up to 30 s for `server status`, prints name, engine, root, pid, surface, socket, stateRoot, binaryPath, releaseMode, copyOf and sourceCommit. A daemon that exits at boot refuses `daemon_exited` with serve.log's last line; one that reports `atomic` is stopped and refused `atomic_release`. N defaults to `hv` and is lowercased |
| `scratch down` | `hv scratch down N [--dry-run]` | Terminates N's live runtimes, stops its daemon, closes its tab, removes `run/`, `state/`, `release/` and `wrkq/` |
| `scratch list` | `hv scratch list` | Every scratch under `/tmp/hv` with pid and liveness |
| `run` | `hv run N -- CMD…` | Runs CMD with only `HRC_RUNTIME_DIR` and `HRC_STATE_DIR` pointed at N, so `hrc` and `curl` address the scratch. Refuses `not_up` without a socket |
| `env` | `hv env N` | Prints the two `export` lines, for a shell or a ghostmux `--command` |
| `rec` | `hv rec FILE 'CMD'` | Runs CMD under `bash -c`, appends `## <UTC>`, `$ CMD`, output and `exit N` to FILE, echoes the output and returns CMD's exit code |
| `evidence` | `hv evidence N DIR` | Copies `serve.log`, the launcher generated by `hv scratch up` at `/tmp/hv/N/launch.sh` (to `DIR/launch.sh`), and the hrcpty supervisor logs (`run/logs/hrcpty/*.log`, into `hrcpty/`) and writes status, runtimes, sessions and an `hrc_events` dump into DIR |

`HV_HOME` overrides `/tmp/hv`; keep it short (feature 2: a long root fails each birth with "broker socket path too long" on native, "File name too long" at boot on Bun). `HV_ASPD_SOCKET` overrides
the aspd socket the scratch prepares through.
