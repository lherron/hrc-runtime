# broker-tmux interactive cutover — final validation findings

Run directory: `runs/20260529T044555Z`
Tier: `core+` (sweep/orphan lifecycle + endurance + cert-matrix; CLI-surface matrix cross-referenced to `runs/20260529T034800Z`)
Date: `2026-05-29`
Operator: clod@hrc-runtime:primary (coordinator, agent-tasker round for T-01691)

## Driver note (IMPORTANT)

The ghostmux real-Ghostty driver was **BLOCKED this run by T-01742** — `ghostmux send-keys`
returns `error: Terminal model unavailable` for every freshly-created surface and never realizes
(persisted across a clean force-restart of ScriptableGhostty; Lance away, no foreground GUI session
to realize the terminal model). This is a pre-existing ghostmux/ScriptableGhostty defect, NOT a
broker-tmux or T-01691 fault.

The broker-tmux interactive route is independent of the Ghostty front-end, so this run drove it via
the **detached-tmux method** (a plain `tmux` pane running `hrc run <scope>` — the T-01735 method this
harness supersedes). This is a REAL exercise of the broker-tmux path: real interactive PTY, real
HRC-owned lease socket, real `harness-broker` controller, real event flow — not a synthetic stand-in.
The CLI-surface matrix (dm/send/turn/peek/capture/interrupt/reattach) was already validated live via
the ghostmux driver at `runs/20260529T034800Z` against the SAME substrate; larry's 507c487
(kill RPC + dead-socket sweep) did not touch interactive routing, so that matrix remains valid.

## Environment

- Claude target: `clod@hrc-runtime:t01691endur`
- Claude runtime: `rt-902d4b07-7f1a-4202-9398-adad183ac04d` (driver claude-code-tmux, ctrl harness-broker, transport tmux)
- Claude lease socket: `var/run/hrc/btmux/claude-code--rt-902d4b07-7f1a-4202-9398-adad1.sock`
- Default socket baseline: `inode=184547294 mtime=1780020283` (var/run/hrc/tmux.sock)
- Monitor start seq: `272690`
- Broker flags: **ON (cutover state)** — HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED=1, HRC_CODEX_CLI_TMUX_BROKER_ENABLED=1, HRC_HEADLESS_CODEX_BROKER_ENABLED=1 (daemon pid 69596)
- Code under test: commit 507c487 (F-V3 kill RPC + F-V4 dead-socket sweep) loaded from source via bun

## Rollup

- Overall: **PASS** — all final-round validation items green.
- Default socket untouched for the whole run: **YES** (inode 184547294 / mtime 1780020283 unchanged baseline→teardown).
- Event journal payload-bearing and complete: **YES** — 57/57 lines carry `payload` (rides monitor Fix A/B, d517948).
- New defects filed this run: threading/reply-to anchor-lookup anomaly (see Defects). T-01742 reconfirmed (ghostmux driver block).

## Items validated (H-00031 final round)

| Item | Validation | Result | Evidence |
|---|---|---:|---|
| 1 — dead lease socket cleanup | Restart startup sweep removed all 14 stale `btmux/*.sock` | **PASS** | daemon log `broker.dead_lease_socket_removed` ×14 @04:37:16; btmux 16→1 |
| F-V4 — dead-socket-file leak fixed | unclaimed, past-grace, no-server `.sock` files rm'd in the sweep loop | **PASS** | same; clean-terminate also rm'd lease (killServer) — verified at teardown |
| 2 — orphan sweep under a LIVE orphan | OLD live orphan (past grace) swept; FRESH (within grace) survived | **PASS** | `broker.orphan_lease_swept` for `hrc-claude-code-rtORPHANOLDTEST`; FRESH session alive post-restart; deterministic via socket-mtime backdating (sweep ages by `stat().mtimeMs`) |
| F-V3 — kill reaps lease servers | `POST /v1/server/tmux/kill-broker-leases` RPC reaped an unclaimed live lease (graceMs=0), default server untouched | **PASS (RPC live)** | `{"ok":true,"scanned":1,"killedLiveLeaseServers":1,"skippedClaimed":0}`; full `hrc server tmux kill --yes` (also kills default) validated by larry on an isolated daemon + unit tests (claimed-preserved, daemon-unavailable honest fatal). Not run full on shared daemon (would kill other agents' hsid sessions). |
| 3 — cert-matrix vs HRC | `turn.completed` per turn (rawType-agnostic); payload carries `last_assistant_message` (terminal assistant message from Stop) | **PASS** | journal `events/cc.jsonl`: turn.completed ×6, `last_assistant_message` = `ENDUR-5\n`/`ENDUR-6\n`; 57/57 payload-bearing |
| 4 — multi-turn / continuation / interrupt endurance | 7 sequential turns (ENDUR-1..7) on ONE broker-tmux session; continuity held; **no headless fallback**; interrupt | **PASS** | headless count 1051→1051 (no fallback); session continuity across 7 turns; default-sock untouched throughout. Interrupt: covered by committed `runs/20260529T034800Z` core-interrupt (C-c reached lease pane, aborted in-flight turn); fresh attempt this run completed too fast to catch mid-flight. |
| CLI surface matrix (dm/send/turn/peek/capture/interrupt/reattach + default-sock invariant) | both drivers | **PASS (cross-ref)** | `runs/20260529T034800Z/findings.md` — substrate unchanged by 507c487 |

## Cutover

- Permanent: `launchd/com.praesidium.hrc-server.plist` flipped CC/CX 0→1 (minimal 2-line diff), cp'd to
  `~/Library/LaunchAgents/`, reloaded via bootout/bootstrap; running daemon confirmed all three broker
  flags = 1. broker-tmux is now the DEFAULT interactive route for claude-code-tmux + codex-cli-tmux.

## Defects / follow-ups

- **Threading anchor-lookup anomaly** (NEW, separate from broker-tmux): ENDUR-7's inbound DM carried a
  `replyToMessageId` that `hrcchat dm --reply-to` rejected as `[malformed_request] unknown
  replyToMessageId`; ENDUR-1..6 anchors all accepted; resend without `--reply-to` succeeded. Token
  delivery + session continuity were unaffected. Filed for hrcchat reply-to anchor resolution.
- **T-01742** (reconfirmed): ghostmux/ScriptableGhostty `send-keys` "Terminal model unavailable" wedge;
  ghostmux GUI driver unusable headless / Lance-away. The runbook needs a documented detached-tmux
  fallback for unattended runs.
- T-01738 F-V1/F-V2/F-V5 remain open (operator-visibility nice-to-haves), re-deferred this round.
