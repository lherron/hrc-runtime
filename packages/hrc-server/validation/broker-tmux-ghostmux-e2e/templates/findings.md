# broker-tmux ghostmux E2E findings

Run directory: `REPLACE_WITH_RUN_DIR`
Tier: `REPLACE_WITH_TIER`
Date: `REPLACE_WITH_DATE`

## Environment

- Claude target: `REPLACE_WITH_CC_TARGET`
- Codex target: `REPLACE_WITH_CX_TARGET`
- Claude runtime: `REPLACE_WITH_RT_CC`
- Codex runtime: `REPLACE_WITH_RT_CX`
- Claude lease socket: `REPLACE_WITH_CC_LEASE`
- Codex lease socket: `REPLACE_WITH_CX_LEASE`
- Default socket baseline: `REPLACE_WITH_DEFAULT_BASELINE`
- Monitor start seq: `REPLACE_WITH_RUN_START_SEQ`

## Rollup

- Overall: TODO
- New defects filed: TODO
- Default socket untouched for all rows: TODO
- Event journals payload-bearing and complete: TODO

## Known Accepted Deviations

- T-01738 F-V1: `hrc runtime inspect` has `tmuxJson=null` for broker-tmux runtimes.
- T-01738 F-V2: `hrc server tmux status` reports the default server only.
- T-01738 F-V3: `hrc server tmux kill --yes` kills the default server only; not executed on the shared daemon.
- T-01738 F-V4: dead lease socket-file leak.
- T-01738 F-V5: `hrc runtime adopt` does not verify dead-lease liveness.
- Bridge socket plumbing is deferred on T-01737 if regressions reappear.
- `hrcchat peek` prefer-interactive resolver follow-up is on T-01737 if regressions reappear.

## Core Matrix

| Row ID | Command | Claude | Codex | Evidence | Notes |
|---|---|---:|---:|---|---|
| core-dm | `hrcchat dm <target>` | TODO | TODO | `evidence/core-dm/` | Must inject into lease pane; no headless fallback; zero `literal_delivery_failed`. |
| core-send-enter | `hrcchat send <target> --enter` | TODO | TODO | `evidence/core-send-enter/` | Literal keystrokes land in lease pane and submit. |
| core-turn-stacked | `hrcchat turn --stacked` | TODO | TODO | `evidence/core-turn-stacked/` | Bounded ndjson; `turn.completed`; no silent fallback. |
| core-peek | `hrcchat peek` | TODO | TODO | `evidence/core-peek/` | Output matches lease-pane capture. |
| core-capture | `hrc capture` / `hrc runtime capture` | TODO | TODO | `evidence/core-capture/` | Captures lease pane, not default server. |
| core-interrupt | `hrc runtime interrupt` | TODO | TODO | `evidence/core-interrupt/` | C-c reaches lease pane and aborts in-flight turn. |
| core-default-socket | default socket invariant | TODO | TODO | all rows | Inode and mtime unchanged versus `default-sock.baseline`. |
| core-event-journal | monitor journal invariant | TODO | TODO | `events/` | `runtime:<rt> --from-seq <start> --json` includes payload and ids. |

## Full Matrix

| Row ID | Command | Result | Evidence | Notes |
|---|---|---:|---|---|
| full-summon | `hrcchat summon` then a turn | TODO | `evidence/full-summon/` | Prewarm must not force headless fallback. |
| full-doctor | `hrcchat doctor <target>` | TODO | `evidence/full-doctor/` | Reports live tmux runtime. |
| full-who | `hrcchat who` / `--json` | TODO | `evidence/full-who/` | Broker-tmux targets visible. |
| full-monitor | `hrc monitor show/watch/wait` | TODO | `evidence/full-monitor/` | Selector prefix required; payload shows tmux pane surface. |
| full-list-inspect | `hrc runtime list --transport tmux` / `inspect` | TODO | `evidence/full-list-inspect/` | T-01738 F-V1 accepted if unchanged. |
| full-sweep | `hrc runtime sweep --dry-run` | TODO | `evidence/full-sweep/` | Must not sweep live broker lease. |
| full-adopt | `hrc runtime adopt` | TODO | `evidence/full-adopt/` | T-01738 F-V5 accepted if unchanged. |
| full-attach | `hrc attach --dry-run` | TODO | `evidence/full-attach/` | Plan points at lease socket/pane. |
| full-surface | `hrc surface bind/unbind/list` | TODO | `evidence/full-surface/` | `surfaceId == paneId`. |
| full-bridge | `hrc bridge target/deliver-text/deliver/list/close` | TODO | `evidence/full-bridge/` | Delivery reaches lease pane. |
| full-server-tmux-status | `hrc server tmux status` | NOTE | `evidence/full-server-tmux-status/` | T-01738 F-V2 accepted if default-only. |
| full-server-tmux-kill | `hrc server tmux kill --yes` | NOTE | code-read only | Do not execute on shared daemon. |
| full-reconcile-restart | daemon restart with lease pane alive | TODO | `evidence/full-reconcile-restart/` | `runtime.reassociated`, no attach, still drivable. |
| full-pre-hrc | `scripts/pre-hrc-broker-matrix-e2e.ts` | TODO | `evidence/full-pre-hrc/` | Retained per C-02889. |

## Event Journal Review

- `events/cc.jsonl`: TODO
- `events/cx.jsonl`: TODO
- Required event examples:
  - `terminal.surface.reported` with `payload.kind=tmux-pane`, `surfaceId`, and `paneId`
  - `turn.completed` with payload body details
  - `surface.bound` ids
  - `runtime.reassociated` for restart row when full tier is run

## Defects

- TODO
