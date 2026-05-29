# timeline

- 2026-05-29T11:28:54Z captured default socket baseline and monitor highWaterSeq=273455.
- 2026-05-29T11:29:05Z plain hrc start on cody@hrc-runtime:btmux-e2e-cody-20260529T112854Z produced headless rt-0784f2bf; excluded from broker-tmux PASS criteria.
- 2026-05-29T11:29:58Z hrc run --no-attach started broker-tmux rt-2165edc1 with lease socket codex-cli-tm-rt-2165edc1-9e35-4d3e-9d09-4dede.sock; btmux leases=1.
- 2026-05-29T11:30:51Z core-dm PASS: DM #4252 reached lease pane; reply DM-OK-CX-112854 returned as #4254.
- 2026-05-29T11:31:09Z core-turn-stacked PASS: stacked final result success; finalBody TURN-OK-CX-112854; reply #4257 received.
- 2026-05-29T11:32:54Z clod broker-tmux runtime rt-561ddc84 allocated under btmux lease socket; btmux leases included claude-code-tmux and codex-cli-tmux targets.
- 2026-05-29T11:33:17Z core-dm PASS for Claude: DM #4264 reached lease pane; reply DM-OK-CC-112854 returned as #4265.
- 2026-05-29T11:33:38Z core-turn-stacked PASS for Claude: stacked final result success; finalBody TURN-OK-CC-112854; reply #4267 received.
- 2026-05-29T11:34:xxZ evidence captured; default socket inode/mtime unchanged.
- 2026-05-29T11:33:40Z Claude broker CORE rows also PASS on rt-561ddc84: DM-OK-CC-112854 and TURN-OK-CC-112854 reached the lease pane; default socket remained unchanged.
- 2026-05-29T11:36:04Z findings.md added for the shared-daemon manual core pass.
- 2026-05-29T11:35:56Z teardown complete: events dumped from seq 273455
