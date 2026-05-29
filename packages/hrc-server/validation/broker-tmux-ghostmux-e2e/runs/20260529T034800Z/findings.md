# broker-tmux ghostmux E2E findings

Run directory: `runs/20260529T034800Z`
Tier: `core`
Date: `2026-05-29`
Operator: clod@hrc-runtime:primary (driven live via ghostmux real Ghostty surfaces)

## Environment

- Claude target: `clod@hrc-runtime:gm-cc-20260529T034800Z`
- Codex target: `cody@hrc-runtime:gm-cx-20260529T034800Z`
- Claude runtime: `rt-35c48cb2-ff9d-43c3-a302-6e20cefcb854` (driver claude-code-tmux, ctrl harness-broker)
- Codex runtime: `rt-f73c3175-b3dd-4501-9e34-4153a16b66bb` (driver codex-cli-tmux, ctrl harness-broker)
- Claude lease socket: `var/run/hrc/btmux/claude-code--rt-35c48cb2-ff9d-43c3-a302-6e20c.sock`
- Codex lease socket: `var/run/hrc/btmux/codex-cli-tm-rt-f73c3175-b3dd-4501-9e34-4153a.sock`
- Default socket baseline: `inode=184547294 mtime=1780020283` (var/run/hrc/tmux.sock)
- Monitor start seq: `271857`
- Real binaries: Claude Code v2.1.156 (Opus 4.8 1M); OpenAI Codex (codex-cli-tmux). Broker flags ON.

## Rollup

- Overall: **PASS** — all 8 CORE rows + the reattach row green for both drivers.
- New defects filed: **T-01742** (ghostmux/ScriptableGhostty: `send-keys` silently fails — "Terminal model unavailable" — when a freshly-created surface has not realized; exits 0). Not a harness fault.
- Default socket untouched for all rows: **YES** (inode 184547294 / mtime 1780020283 unchanged baseline→teardown; only the cosmetic `%Sp` mode-bit display differs).
- Event journals payload-bearing and complete: **YES** — 28 cc events, all payload-bearing; `turn.completed` carried real message bodies (rides hrc monitor Fix A/B, commit d517948).

## Known Accepted Deviations (observed unchanged — not regressions)

- T-01738 F-V1: `hrc runtime inspect` `tmuxJson=null` for broker-tmux runtimes.
- T-01738 F-V2: `hrc server tmux status` reports the default server only.
- T-01738 F-V3: `hrc server tmux kill --yes` kills default server only; not executed on the shared daemon.
- T-01738 F-V4: dead lease socket-file leak — observed ~13 stale `btmux/*.sock` from terminated runtimes.
- T-01738 F-V5: `hrc runtime adopt` does not verify dead-lease liveness.
- `hrcchat turn --stacked`: `stacked summaries disabled; Consul key unavailable` — env-gated LLM summary only; the ndjson stream + final frame (result/finalBody) work. NOT a failure.

## Core Matrix

| Row ID | Command | Claude | Codex | Evidence | Observed |
|---|---|---:|---:|---|---|
| core-dm | `hrcchat dm <target>` | PASS | PASS | `evidence/core-dm/` | Injected into lease pane; replies `DM-OK-CC` / `DM-OK-CX`; **no headless fallback** (headless count 1046→1046); **0** `literal_delivery_failed`. |
| core-send-enter | `hrcchat send <target> --enter` | PASS | PASS | `evidence/core-send-enter/` | CC executed `SEND-OK-CC-literal`; CX injected `SEND-OK-CX-literal` into prompt. |
| core-turn-stacked | `hrcchat turn --stacked` | PASS | PASS | `evidence/core-turn-stacked/` | Bounded ndjson final frame, `result:success`; `finalBody` `TURN-OK-CC` / `TURN-OK-CX`. |
| core-peek | `hrcchat peek` | PASS | PASS | `evidence/core-peek/` | Reads the LEASE pane (matches lease capture). |
| core-capture | `hrc capture` / `hrc runtime capture` | PASS | PASS | `evidence/core-capture/` | Reads lease pane (`TURN-OK-CC` / `TURN-OK-CX` visible). |
| core-interrupt | `hrc runtime interrupt` | PASS | n/a | `evidence/core-interrupt/` | C-c reached CC lease pane: `Interrupted · What should Claude do instead?`; aborted in-flight turn. |
| core-reattach | `hrc run` → detach → `hrc run` (legacy reattach) | PASS | — | `evidence/core-reattach/` | Two confirmations: (1) runtimeId equality — second `hrc run` returned the SAME runtime (`rt-ee91ee1f…` first pass; `rt-58f905a4…` visual pass), runtime stayed `ready` across detach. (2) **Visual continuity** — set marker `REATTACH-MARKER-PINEAPPLE-7321` in surface A, detached (killed A), re-ran in surface B; B's pane capture shows the prior marker (`A-before-detach.txt` / `B-after-reattach.txt`) → reattached the same session, not a fresh boot. |
| core-default-socket | default socket invariant | PASS | PASS | `default-sock.final-compare` | inode/mtime unchanged across the whole run. |
| core-event-journal | monitor journal invariant | PASS | PASS | `events/cc.jsonl`, `events/cx.jsonl` | `runtime:<rt> --from-seq <start> --json`: 28 cc events, all payload-bearing; turn.completed×5 with real bodies. |

## Harness defects found + fixed this run (setup.sh / teardown.sh)

1. **Daemon-readiness race**: setup/teardown called `hrc monitor show` immediately after `bootstrap`, before the socket listened → "daemon socket not found". Fixed with a readiness poll (trap-safe).
2. **Busy-guard gap**: counted stale-zombie + the caller's own session and refused. Added `--allow-busy`.
3. **Silent send failure**: `ghostmux send-keys` exits 0 even on "Terminal model unavailable"; `send_surface_command` now retries + fails loudly (dropped `--literal`; plain paste). Underlying app bug = T-01742.
4. **env.json all-null**: jq field-shorthand (`{schema, tier, defaultSock, …}`) read the `-n` null input instead of `$args` → nulled the default-socket invariant inputs. Fixed to explicit `field: $var`.

## Notes

- Live ghostmux send was intermittently wedged (T-01742); cleared by restarting ScriptableGhostty (this session is tmux-backed and survived). Once healthy, the full matrix ran clean.
- `hrc` runs `src/cli.ts` via bun, so monitor Fix A/B (d517948) was live without `just install`.
- The reattach row (`hrc run` → detach → `hrc run` = same runtime, no new session) confirms the legacy `hrc run` reattach semantics are preserved on the broker-tmux route (no `--force-restart` ⇒ reattach).
