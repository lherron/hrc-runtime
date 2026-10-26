# Restart-self Bun baseline and native comparison

Run from the checkout. Each invocation requires a fresh short `/tmp` root and
copies the selected installed release with `cp -R`; it never starts a daemon
inside an atomic release or changes shared services. The N3 scratch helper
provides a private wrkqd for semantic turn handoff. This workflow deliberately
removes the zero-peer federation config: this is an unfederated subject, since
an existing zero-peer config refuses scoped caller reads.

```sh
python3 crates/hrc-native/e2e/n2_restart_self.py \
  --owner bun --binary /usr/bin/false \
  --installed-release /absolute/pinned/installed-release \
  --aspd-socket /absolute/aspd.sock \
  --scratch-root /tmp/restart-self-bun --artifacts /absolute/evidence/bun
```

Repeat with `--owner native --binary /absolute/hrc-native`, another scratch
root, and `--artifacts /absolute/evidence/native`. The copied Bun CLI drives
both owners, so the comparison isolates daemon behavior. The binary argument
is unused for the Bun owner. No native result is claimed by a Bun-only run.

```sh
python3 conformance/hrc-parity/run.py compare --suite n2-restart-self \
  --baseline /absolute/evidence/bun --candidate /absolute/evidence/native \
  --out /absolute/evidence/compare
```

The driver holds a real model turn in a Bash tool behind a file gate. The
ordinary `hrc restartme --handoff` command uses that owned runtime's credential.
Missing and consumed handoffs are refused; arm/cancel preserves the generation;
arming a second turn cannot fire until its gate opens and its terminal commits.
The zero-delay self-restart callback must then rotate the generation and deliver
exactly one semantic handoff to a fresh runtime. The successor must complete;
the aspd request capture must show two cold compiles and no reused continuation
in the second. This tests the callback firing, not a daemon process restart.

For the live negative control, repeat the Bun command with a fresh scratch root
and artifact directory plus `--negative-control`. It cancels the final arm,
then runs the unchanged execution assertion: expect exit 1 and
`timed out waiting for self-restart timer execution`. Any earlier failure is
an invalid control run. Keep its steps and rows beside the green baseline.

Artifacts include the daemon and private authority logs, full CLI steps,
raw runtime/event/message rows, aspd compile requests, and the semantic checks.
The comparator rechecks the execution-to-terminal correlation, completed
successor, durable semantic request, fresh generation and compile from those
artifacts, then compares the workflow and restart-event payload shapes with
Bun. Missing artifacts fail closed. Scratch processes are stopped in `finally`;
release copies and stores remain under `/tmp` for inspection.
