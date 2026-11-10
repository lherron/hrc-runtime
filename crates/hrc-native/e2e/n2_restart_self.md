# Restart-self on rusthrc

Run from the checkout with a fresh short `/tmp` root. It starts one scratch
rusthrc and never changes shared services. The N3 scratch helper provides a
private wrkqd for the semantic turn handoff. This workflow deliberately removes
the zero-peer federation config: this is an unfederated subject, since an
existing zero-peer config refuses scoped caller reads.

```sh
python3 crates/hrc-native/e2e/n2_restart_self.py \
  --binary /absolute/rusthrc \
  --installed-release /nonexistent \
  --aspd-socket /absolute/aspd.sock \
  --scratch-root /tmp/restart-self --artifacts /absolute/evidence/restart-self
```

`--installed-release` is required by the shared helper and unused here.

The driver holds a real model turn in a Bash tool behind a file gate. The
ordinary `hrc restartme --handoff` command uses that owned runtime's credential.
Missing and consumed handoffs are refused; arm/cancel preserves the generation;
arming a second turn cannot fire until its gate opens and its terminal commits.
The zero-delay self-restart callback must then rotate the generation and deliver
exactly one semantic handoff to a fresh runtime. The successor must complete;
the aspd request capture must show two cold compiles and no reused continuation
in the second. This tests the callback firing, not a daemon process restart.

For the negative control, repeat with a fresh scratch root and artifact
directory plus `--negative-control`. It cancels the final arm, then runs the
unchanged execution assertion: expect exit 1 and
`timed out waiting for self-restart timer execution`. Any earlier failure is
an invalid control run.

Artifacts include the daemon and private authority logs, full CLI steps,
raw runtime/event/message rows, aspd compile requests, and the semantic checks.
Scratch processes are stopped in `finally`; stores remain under `/tmp` for
inspection.
