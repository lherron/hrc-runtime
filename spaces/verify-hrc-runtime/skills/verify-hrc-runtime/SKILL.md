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

- **Scratch (the default for anything that writes).** `hv scratch up --name <task>` starts an isolated
  `hrc server serve` from the installed `hrc` on its own runtime and state roots (`/tmp/hv/<name>/run`,
  `/tmp/hv/<name>/state`), in a fresh ghostmux tab, and waits until it answers `server status`. Run every
  `hrc` verb against it with `hv run <name> -- hrc …`. It is a real daemon with a fresh store: it births
  real harness runtimes (through the live aspd, which only prepares), and it never touches the live
  `state.sqlite`, ACP webhook or event-ingest port. Use it for starts, turns, sends, terminates, resumes,
  sweeps, captures and the HTTP API.
  - Birth the blank agent `tabularasa@hrc-runtime:<slug>` (claude, no spaces) with a one-word prompt
    ("Reply with exactly the word OK and nothing else. No tools."). Each turn is a real model call.
  - The daemon runs in a ghostmux tab because `hrc server serve` refuses to boot under a coding-agent
    harness (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX`; feature 1). Don't work around it by
    unsetting them in your own shell; that is what `hv` does in the clean tab, on purpose.
- **Live (read-only).** The launchd daemon (`com.praesidium.hrc-server`, socket
  `~/praesidium/var/run/hrc/hrc.sock`). On it run `hrc server status`, `hrc doctor`, `hrc target locate`,
  `hrc monitor show|watch|events|transcript|stats|search`, `hrc runtime list|inspect|diagnostics`,
  `hrc admin metrics report`, `hrc admin registrations gc` (no scopes is
  a read-only projection) and dry-run `admin runs`. Use live when the claim is about the installed node
  itself: its release, its federation, its bindings.
- **Never** restart or stop the live daemon (`hrc server restart|stop`), run `just install`, publish, deploy
  or retire on live from this skill. Those belong to Mable primary (restart) and the install doctrine
  (`~/praesidium/build_deploy_guide.md`). When a drive needs one, write the step down, mark it
  `needs operator`, and drive what you can around it.
- Test **what is installed.** `hv` runs the installed `hrc` (`~/.bun/bin/hrc` → the current atomic
  release), not the checkout. A change is not testable here until it is installed; until then say so.

## Doctor

Always start with `hrc doctor` (read-only) and `hrc server status`, and run them again after anything
surprising. On a scratch: `hv run <name> -- hrc doctor`.

```bash
hrc doctor                         # + ok, ~ warn, x fail; exit 0 unless a fail (--strict: warns too)
hrc server status --json | jq '.release | {mode, releaseId, runningEqualsInstalled, src: .hrcBuild.sourceCommit}'
hv run t-xxxxx -- hrc doctor       # scratch: single-node, no bindings
```

On max3 `hrc doctor` prints `~ placement-policy` warns for task scopes whose worktree is gone or ambiguous.
Those are normal and are not a reason to stop; `--strict` turns them into exit 1. Every `hrc server status
--json` path is nested (`.release.runningEqualsInstalled`, `.node.nodeId`); a top-level read answers `null`
for a path that doesn't exist. `hrc info` lists the paths.

## Drive

1. Find the feature in [features/README.md](features/README.md) and read its file.
2. Doctor.
3. Drive it with `hv` and `hrc`, as the file's "Driving it" shows, recording each step with
   `hv rec <artifact_dir>/NN-<feature>/drive.txt '<command>'` as you go ("Evidence" below).
4. Check the file's "Proven when" against what you captured.
5. If the drive disagreed with the file, fix the file (Gotchas, with date and evidence) in the same change.

`hrc --help` (agent view), `hrc --human --help`, `hrc admin --help` (the full cellar), `hrc info` and
`hrc <cmd> --help` give the live surface. `docs/cli-surface.md` and `docs/cli-reference.md` describe it.

## Evidence

- **The installed surface, not a unit test.** A claim is proven by the installed build driven end to end and
  observed in its own outputs: `hrc server status --json`, `hrc monitor` (the lifecycle log and the
  invocation ledger), `hrc_events`, the pane (`hrc peek`, ghostmux capture), the HTTP responses.
- **Grade a turn from the ledger, not the start response.** `hrc start --json` answers at `accepted`; the
  turn's proof is `turn.completed` for its `runId` and the final `turn.message` (`hrc monitor watch`,
  `hrc monitor transcript`), or the `terminal.finalMessage` of `hrc turn --wait final`.
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
  operator: just install` or `needs operator: hrc server restart`).
- **Prove a negative with a discriminator.** A command that answers the same whether the thing is there or
  not proves nothing (`jq` on a missing key is `null`; `turn-finished` armed after the turn exits 20 on
  timeout, not "never finished"). Show the control case beside the subject.

## Cleanup

`hv scratch down <name>` terminates every non-terminated runtime on the scratch, stops the daemon it
started (SIGTERM, then SIGKILL after 5 s), closes its ghostmux tab and removes `run/` and `state/`. It keeps
the daemon's log (serve.log), the launcher script hv wrote for it and its start time (up_at) in
`/tmp/hv/<name>/` for a post-mortem; they are scratch files, not repo paths. A terminated harness can still
name `/tmp/hv/<name>` for a few seconds after `down` returns (a resumed claude for ~3 s on 2026-10-05,
T-10350), so recheck before calling the scratch clean. `--dry-run` prints the plan
first. `hv scratch list` shows what is up. Close any other ghostmux tab you opened
(`ghostmux kill-surface -t <id> --force`) and confirm no process still names the scratch:
`ps -axo pid,command | grep /tmp/hv/<name>`.

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
| `scratch up` | `hv scratch up [--name N]` | Starts the installed `hrc server serve` on `/tmp/hv/N/{run,state}` in a new ghostmux tab, waits up to 30 s for `server status`, prints root, pid, surface, socket, stateRoot, sourceCommit and runningEqualsInstalled. N defaults to `hv` and is lowercased |
| `scratch down` | `hv scratch down N [--dry-run]` | Terminates N's live runtimes, stops its daemon, closes its tab, removes `run/` and `state/` |
| `scratch list` | `hv scratch list` | Every scratch under `/tmp/hv` with pid and liveness |
| `run` | `hv run N -- CMD…` | Runs CMD with only `HRC_RUNTIME_DIR` and `HRC_STATE_DIR` pointed at N, so `hrc` and `curl` address the scratch. Refuses `not_up` without a socket |
| `env` | `hv env N` | Prints the two `export` lines, for a shell or a ghostmux `--command` |
| `rec` | `hv rec FILE 'CMD'` | Runs CMD under `bash -c`, appends `## <UTC>`, `$ CMD`, output and `exit N` to FILE, echoes the output and returns CMD's exit code |
| `evidence` | `hv evidence N DIR` | Copies `serve.log` and writes status, runtimes, sessions and an `hrc_events` dump into DIR |

`HV_HOME` overrides `/tmp/hv`; keep it short (feature 2, "File name too long"). `HV_ASPD_SOCKET` overrides
the aspd socket the scratch prepares through.
