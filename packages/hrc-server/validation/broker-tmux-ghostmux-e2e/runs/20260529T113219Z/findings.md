# broker-tmux ghostmux E2E findings

Run directory: `packages/hrc-server/validation/broker-tmux-ghostmux-e2e/runs/20260529T113219Z`
Tier: `core-manual`
Date: `2026-05-29T11:32:19Z`

## Environment

- Claude target: not exercised in this manual shared-daemon pass
- Codex target: `cody@hrc-runtime:btmux-e2e-cx-20260529T112854Z`
- Claude runtime: not exercised
- Codex runtime: `rt-2165edc1-9e35-4d3e-9d09-4dede09af714`
- Codex legacy same-scope runtime observed: `rt-4ab5429f-d391-400d-b920-c5ff9eb7a85e` on default `tmux.sock`
- Codex lease socket: `/Users/lherron/praesidium/var/run/hrc/btmux/codex-cli-tm-rt-2165edc1-9e35-4d3e-9d09-4dede.sock`
- Default socket baseline: `path=/Users/lherron/praesidium/var/run/hrc/tmux.sock inode=184547294 mtime=1780020283 size=0 mode=srwx------`
- Monitor start seq: `273624`

## Rollup

- Overall: PASS for requested Codex CORE rows 1 and 3
- New defects filed: none
- Default socket untouched for requested rows: PASS; inode and mtime unchanged after validation
- Event journals payload-bearing and complete: PASS for inspected rows

## Core Matrix

| Row ID | Command | Claude | Codex | Evidence | Notes |
|---|---|---:|---:|---|---|
| core-dm | `hrcchat dm <target>` | N/A | PASS | `evidence/core-dm/` | DM appeared in the broker lease pane and reply `BTMUX-DM-OK` threaded back as seq 4255. The default-socket pane stayed blank. Monitor showed broker-source completion for `run-6ffe101a-f591-4a07-b179-fd10bf27a7f0`. |
| core-turn-stacked | `hrcchat turn --stacked` | N/A | PASS | `evidence/core-turn-stacked/` | Explicit stacked turn returned final body `EXPLICIT-BTMUX-TURN-OK`; monitor showed `turn.accepted`/`turn.completed` for `run-fe4c482d-1080-437a-831f-3d00e8f96680` with `delivery=interactive-literal`. |
| core-default-socket | default socket invariant | N/A | PASS | all rows | Baseline and final default socket stat match exactly: inode `184547294`, mtime `1780020283`. |

## Notes

- This was a manual shared-daemon pass. I did not run `setup.sh`, did not restart `hrc-server`, and did not create Ghostty/ghostmux surfaces.
- `hrc server tmux status` reported `btmux leases: 1` for the Codex lease socket.
- The validation target also had an older same-scope default-socket tmux runtime (`rt-4ab5429f-d391-400d-b920-c5ff9eb7a85e`). The tested DM and stacked turn landed in the broker lease pane, not that default-socket pane.
- `hrcchat turn --stacked` printed the accepted fallback note `stacked summaries disabled; Consul key unavailable: cfg/dev/_global/llm/anthropic/api_key`, then emitted interval/final ndjson successfully.

## Defects

- None.
