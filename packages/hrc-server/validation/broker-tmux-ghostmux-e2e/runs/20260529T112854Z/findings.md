# broker-tmux ghostmux E2E findings

Run directory: `runs/20260529T112854Z`
Tier: `core-dm-turn`
Date: `2026-05-29`
Operator: cody@hrc-runtime:primary

## Scope

Validated only the two requested CORE rows against fresh post-cutover interactive broker-tmux runtimes:

- CORE row 1: `hrcchat dm <target>`
- CORE row 3: `hrcchat turn --stacked <window> <target>`

The runbook `setup.sh` path was not used because it can restart the shared daemon. Validation used fresh cold task scopes and the detached-tmux fallback.

## Environment

- Codex target: `cody@hrc-runtime:btmux-e2e-cx-20260529T112854Z`
- Codex runtime: `rt-2165edc1-9e35-4d3e-9d09-4dede09af714` (`controllerKind=harness-broker`, `transport=tmux`, driver `codex-cli-tmux`)
- Codex lease socket: `/Users/lherron/praesidium/var/run/hrc/btmux/codex-cli-tm-rt-2165edc1-9e35-4d3e-9d09-4dede.sock`
- Claude target: `clod@hrc-runtime:btmux-e2e-cc-20260529T112854Z`
- Claude runtime: `rt-561ddc84-2608-4bf8-839a-d87d03ca031e` (`controllerKind=harness-broker`, `transport=tmux`, driver `claude-code-tmux`)
- Claude lease socket: `/Users/lherron/praesidium/var/run/hrc/btmux/claude-code--rt-561ddc84-2608-4bf8-839a-d87d0.sock`
- Default socket baseline: `inode=184547294 mtime=1780020283`
- Broker flags observed ON: `HRC_HEADLESS_CODEX_BROKER_ENABLED=1`, `HRC_CODEX_CLI_TMUX_BROKER_ENABLED=1`, `HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED=1`

## Rollup

- Overall: **PASS** for the requested rows on both Codex and Claude broker-tmux targets.
- New defects filed: none.
- Default socket untouched: **YES**. Baseline and final `/Users/lherron/praesidium/var/run/hrc/tmux.sock` inode/mtime both remained `184547294 / 1780020283`.
- No headless fallback for validation targets: **YES**. Runtime inventory for the pass targets shows `controllerKind=harness-broker`, `transport=tmux`, and per-runtime btmux lease sockets.
- Event journals: captured for both runtimes under `events/`. Monitor rows include `turn.completed` and final messages for both `TURN-OK-CX-112854` and `TURN-OK-CC-112854`.

## Core Matrix

| Row ID | Command | Claude | Codex | Evidence | Observed |
|---|---|---:|---:|---|---|
| core-dm | `hrcchat dm <target>` | PASS | PASS | `evidence/core-dm/` | DM reached the lease panes. Codex replied `DM-OK-CX-112854` as #4254. Claude replied `DM-OK-CC-112854` as #4265. |
| core-turn-stacked | `hrcchat turn --stacked 2s <target>` | PASS | PASS | `evidence/core-turn-stacked/` | Both commands emitted bounded `turn_stacked` ndjson and final `result:"success"`. Codex finalBody was `TURN-OK-CX-112854\n`; Claude finalBody was `TURN-OK-CC-112854\n`. |
| core-default-socket | default socket invariant | PASS | PASS | `default-sock.final-compare` | Default socket inode/mtime unchanged baseline to final. |
| core-event-journal | monitor journal invariant | PASS | PASS | `events/cc.jsonl`, `events/cx.jsonl` | Journals captured against `runtime:<broker-runtime>` selectors; `turn.completed` and final message rows present. |

## Notes

- A plain `hrc start cody@hrc-runtime:btmux-e2e-cody-20260529T112854Z` created a headless runtime and was not used for pass criteria.
- `hrc run --no-attach` returned legacy default-socket runtime records while also spawning the broker runtimes. Validation targeted the broker runtime records selected by `controllerKind=harness-broker` and the per-runtime lease sockets.
- One transient Claude broker allocation, `rt-9498cadf-6545-4456-9fec-89685684fcbd`, terminated during startup. A subsequent allocation, `rt-561ddc84-2608-4bf8-839a-d87d03ca031e`, was ready and used for the PASS rows.
- `hrcchat` printed `stacked summaries disabled; Consul key unavailable: cfg/dev/_global/llm/anthropic/api_key`; this only disables LLM summaries. The ndjson stream and final result frames completed successfully.
- Teardown was run with `--skip-flag-restore`; all validation runtimes were terminated and `hrc server tmux status` reported `btmux leases: 0` afterward.
