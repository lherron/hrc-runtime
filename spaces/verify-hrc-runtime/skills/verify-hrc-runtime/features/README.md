# HRC runtime feature map

One file per feature. Each has the same sections: Sub-features, How to get to it, Driving it, Gotchas and
Proven when. The last lines of each file name the drive that last proved it and where its evidence is.

| # | Feature | File | Drive on |
| --- | --- | --- | --- |
| 1 | Server health (`server status`, `doctor`, `info`, `server subscribers`, `server tmux status`, release block, the harness guard on `server serve`) | [01-server-health.md](01-server-health.md) | live read-only; scratch |
| 2 | Runtime lifecycle (`start`, `show`, `ls`, `runtime list/inspect/status/capture/terminate`, `session list/resolve/get/meta get`, `peek`, `send`, `summon`, `resume`) | [02-runtime-lifecycle.md](02-runtime-lifecycle.md) | scratch |
| 3 | Turns and monitor (`turn`, `turn --attach`, `monitor show/watch/wait/events/transcript/stats/search/session-report`) | [03-turns-monitor.md](03-turns-monitor.md) | scratch; live read-only |
| 4 | HTTP API on the daemon socket (`/v1/health`, `/v1/events/tail` paging and refusals, `/v1/events/head`) | [04-http-api.md](04-http-api.md) | scratch |
| 5 | Placement and federation (`target locate`, `target bindings`, doctor's node/federation/placement rows, `registrations gc` projection) | [05-placement-federation.md](05-placement-federation.md) | live read-only; scratch |
| 6 | Install and release (atomic release, manifest, `runningEqualsInstalled`, release pruning, the dirty guard) | [06-install-release.md](06-install-release.md) | live read-only; install needs operator |
| 7 | Maintenance (`admin runs`, `admin metrics`, `admin status`, `runtime diagnostics`, `runtime sweep/prune` dry-runs, `capture status`, `broker-verify candidates/run`, `worktrees audit`, the prune-deltas job) | [07-maintenance.md](07-maintenance.md) | scratch; live read-only |
| 8 | Attach (`hrc attach` in a real TTY through ghostmux, detach, the attach descriptor) | [08-attach.md](08-attach.md) | scratch |

Not mapped here: the viewer (it ships from ACP now) and the mail injector (agent-control-plane's
`hrc-mail-injector`). `hrc federation retire`, `hrc server restart|stop`, `just install|publish|deploy-*` are
named in their features but are operator steps, never driven by this skill. Also not mapped, from the live
surface on 2026-10-05 (T-10350):

- Continuity writes `session rotate`, `session meta set|clear`, `session retitle` (deprecated alias of meta),
  `session drop-continuation`, and run plumbing `runtime send` and `runtime interrupt`: feature 2 names them;
  terminate and resume prove the continuation path, and nothing in this skill yet needs them driven.
- `admin surface bind|unbind|list` and `admin bridge target|deliver-text|register|deliver|list|close`:
  low-level delivery plumbing that ACP and the mail injector drive; prove them from those consumers.
- `admin runtime ensure|prune` (prune deletes keep-forever ledgers by exact manifest), `admin events drain`
  (a dead container's ledger) and `server tmux kill`: operator repairs on real state.

## Keeping the map honest

- Change a feature, change its file in the same commit. A file with no drive behind it is a draft: say so at
  its end.
- When a drive turns up something the file doesn't say, add it to Gotchas with the date and the evidence
  path. When a Gotcha stops being true, delete it, or say which commit ended it.
- Re-drive a feature after any change to its code. Put the evidence under your task's `artifact_dir` in
  [SKILL.md](../SKILL.md)'s layout and update the file's last lines.
- `docs/` (cli-surface, cli-reference, lifecycle-event-tail, atomic-install, isolated-daemon-smoke-recipe)
  says what was specified. These files say what the installed build does and how to watch it do it.
