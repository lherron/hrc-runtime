---
id: hrc-runtime/operations-runbook
title: HRC runtime operations runbook
kind: runbook
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# HRC runtime operations runbook

Current operations for the native `rusthrc` daemon and `hrc` CLI. max3, svc
(mini), and hrcdev use the native owner under the launchd label
`com.praesidium.hrc-server`. The retained Bun implementation and its launchd
template are not evidence of the running owner.

## Runtime locations and owner readback

Default roots on max3:

- Socket: `~/praesidium/var/run/hrc/hrc.sock`
- State DB: `~/praesidium/var/state/hrc/state.sqlite`
- Installed supervisor: `~/Library/LaunchAgents/com.praesidium.hrc-server.plist`
- Owner executable: `~/praesidium/var/hrc-owner/hrc-runtime-current/bin/rusthrc`

Read the installed plist and live status rather than assuming the checked-in
Bun template describes the node:

```bash
bash scripts/hrc-owner.sh kind
bash scripts/hrc-owner.sh log-path
hrc server status --json
```

`kind` must report `rusthrc`. Status must name the owner executable in
`binaryPath`; inspect `.release.hrcBuild.sourceCommit`,
`.release.runningEqualsInstalled`, `.node.nodeId`, `.api.socketPath`, and
`.api.listenSocketPath`. On the direct native owner the two API socket paths
agree. These are nested fields; a missing field is not a successful check.

The owner log currently differs by node: max3 uses
`~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log`; svc and hrcdev use
`~/praesidium/var/logs/rusthrc-owner.log`. `hrc-owner.sh log-path` reads the
node's installed plist. The structured log uses JSON lines with `ts`, `level`,
`component`, `event`, and `data`. The old `hrc-server.log` path describes the
Bun owner, not the native owner's current output.

For routine seat/runtime inspection use the kernel projection, avoiding a
whole-table daemon scan:

```bash
python3 -I crates/hrc-kernel/e2e/kq.py status
python3 -I crates/hrc-kernel/e2e/kq.py seats
python3 -I crates/hrc-kernel/e2e/kq.py busy
```

Check ingest lag in `status`. Seat active/inactive and runtime busy/ready are
different facts. Do not restart the kernel to refresh a read: a cold bootstrap
is expensive and blanks Loggia.

## Restart doctrine

### Install and deploy

Build, install, publish, and activation are separate states. Follow
[atomic-install.md](atomic-install.md) for local release selection and its
pre-cutover checks, including the kernel bootstrap gate. A failed candidate
must leave `current` unchanged. A local install does not activate the daemon.

For fleet changes follow [fleet-deployment.md](fleet-deployment.md):
`just deploy-max3` advances and publishes max3 first; `just deploy-svc` and
`just deploy-hrcdev` consume `@max3` without publication. `just deploy-fleet`
resolves targets from what max3 is running. Use `just fleet-status` for the
HRC, aspd, and injector readbacks. Parity means matching source commits, not
per-node set versions.

**Restart authority.** Only `mable@<project>:primary` may restart shared
services on any node. Mable's `minisvc` seat may restart its own svc HRC;
`mable@hrc-runtime:hrcdev` may restart its own hrcdev HRC. Lance retains
operator authority. Other agents request the exact action through `wrkc` to
Mable's appropriate seat. A recipe or task brief grants no lifecycle authority.
The daemon checks its minted lifecycle credential; a credential-less shell
cannot substitute for the authorized seat. `--reason` is required.

For an authorized activation after installation:

```bash
hrc server restart --force --reason 'activate the selected HRC release'
hrc server status --json
```

Use `--node <id>` for a peer. Default stop/restart gates refuse in-flight work;
`--wait` drains up to `--wait-timeout-ms` (default 300000), while `--force`
skips that gate. Tmux runs are excluded from the restart gate. Brokers reattach
across restart, so busy runtimes are not a reason to wait for a quiet window;
a wait that includes the invoking turn cannot drain. Mable restarts at most
once per validation cycle and continues validation afterward.

After restart require `.release.runningEqualsInstalled == true` and the
expected source commit and owner `binaryPath`. Read `broker.warmup.complete`
in the actual owner log: `data.attached` must equal `data.total`, with no
failure categories. A healthy socket alone does not prove the intended build
is running. An immediately missing pid can be pid-file lag; reread status.

Restart/kickstart does not reload launchd plist environment or argv. A plist
change requires an authorized bootout/bootstrap. Do not use direct launchctl
commands to bypass the lifecycle authority rule.

## Persona allowlist: legacy Bun only

The retained Bun `server serve --allow-persona ...` option is not a native
execution boundary. The native summon implementation explicitly has no local
persona allowlist (`crates/hrc-native/src/server/placement/federation/summon.rs`).
Do not infer enforcement from generated CLI help or configure a native
supervisor expecting that Bun option to protect it. A requirement for that
boundary needs an owner decision before deployment.

## Dependency sync (ASP → HRC)

HRC consumes published ASP tuples through Verdaccio at `http://mini:4873/`.
Editing `../agent-spaces` has no effect on an installed HRC release until the
producer is published and the consumer lock advances.

1. Publish the coherent ASP producer set through agent-spaces' supported
   workflow, with its owner.
2. In HRC run `just pull-deps`. It advances `bun.lock` coherently and creates a
   lock-only commit. Read `git log -1 -- bun.lock` and run
   `bun scripts/check-lock-coherence.ts`; a no-op pull does not prove freshness.
3. Push the lock commit, then use the authorized install/deploy flow above.
   Read back native HRC's `.release.aspContracts` and the independent aspd service release
   at `.api.aspd.release`. Package consumption and aspd activation are separate.

`just check-deps` is read-only. Never use `bun update`, `bun add`, hand-edited
manifests, or individual package publication to advance a synced set. The dev
workspace's source links are for editing; release bytes come from the lock.
ACP advances its own producer pins; an HRC install does not release ACP.
See [development-workflow.md](development-workflow.md) for the cross-repo flow.

## Validation and isolation

`just verify` is the landing gate: architecture records, crate-edge checks,
and the cargo leg when Rust inputs changed. It runs no Bun suites and does not
provision a Bun daemon. Run `just verify-bun` by hand only for Bun/TypeScript
changes; that recipe provisions its own ephemeral daemon and fixture homes.
For TS project references, build before typecheck. Repo-owned `.githooks`
apply path-scoped validation; do not substitute stale `.git/hooks` templates.

A docs-only change needs its applicable structural checks and landing hooks,
not an install or restart. A runtime change additionally needs validation of
the installed native surface with real configuration. The justfile exposes
`just e2e-native-full` for the native workflow; select the relevant driver
under `crates/hrc-native/e2e/` or `crates/hrc-cli/e2e/` for narrower changes.
Record the source commit, installed/running identity, commands, and artifacts.

An isolated daemon is appropriate for probes that write or need controlled
state. Busy peers do not make a shared restart unsafe. Use a scratch copy of
the installed release with fresh runtime/state roots and a clean supervisor
shell; never start another daemon directly from an atomic installed release.
Never copy the live multi-GB store to seed a probe. Keep non-production daemons
viewer-free. Clean up every runtime, process, socket, and scratch root you
create and disclose any remaining debris. The historical Bun smoke recipe
[isolated-daemon-smoke-recipe.md](isolated-daemon-smoke-recipe.md) must not be
counted as proof of native-owner behavior.

The native foreground path retains the harness guard against
`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, and `CODEX_SANDBOX` inheritance
(`crates/hrc-cli/src/server_start.rs`). Start an isolated native daemon in a
clean external terminal, never by bypassing the guard in the agent turn.
If running the Bun-only gate, inspect its ephemeral daemon log on startup
failure; do not force-boot the production daemon under harness environment.

## Retention and long-running turns

The native zombie sweeper defaults to 1800 seconds of event silence
(`crates/hrc-native/src/server/broker/sweeps.rs`); process liveness alone does
not protect a headless run. Account for this during long tool calls.

[state-retention.md](state-retention.md) owns the retention policy and
exemptions. Observation history defaults to three days and completed runtime
buffers to one day. Terminated runtime rows and retirement fences are permanent
history, not TTL candidates. Before a bulk prune require a full backup; if it
cannot fit, defer the prune. Rolling nightly increments are exempt (C-10736).
Never take a torn filesystem copy of a live WAL database. Full VACUUM remains
an offline coordinated operation.

## Viewer and mail injector ownership

`hrc-viewer` ships and is supervised from **agent-control-plane**, not HRC.
Its source is `agent-control-plane/packages/hrc-viewer`, its plist is
`agent-control-plane/launchd/com.praesidium.hrc-viewer.plist`, and its
`install-hrc-viewer-launchd` recipe belongs to that checkout. Ask the ACP
service owner for activation or removal. HRC's `just install` does not install
the viewer. Viewer logs are in
`~/praesidium/var/logs/agent-control-plane/hrc-viewer.log`.

There is exactly one viewer per GUI user, bound to that user's production
HRC. Non-production daemons never receive a viewer. HRC publishes durable
presentation facts; the sidecar alone actuates Ghostty and must not mutate
runtime lifecycle. The shipped boundary is recorded in
[the active invariant](../architecture/records/invariants/hrc-runtime.viewer-presentation-sidecar.yaml).
The completed extraction's approved rev 3 design is preserved on T-07595
(sidecar build and production validation), attachment ATT-00414; its phase
plans and historical TS call sites are not current operating instructions.
Retrieve it with `wrkq attach get ATT-00414 -o <path>`.

The mail injector also belongs to ACP (`packages/hrc-mail-injector`,
`com.praesidium.hrc-mail-injector`). Its log is
`var/logs/hrc-runtime/hrc-mail-injector.log` and private state is
`var/state/acp/hrc-mail-injector.sqlite` (`HRC_MAIL_INJECTOR_STATE_PATH`).
Old `hrcmail_*` tables in HRC's state DB are pre-split leftovers, not current
mail state. For deployment and supervision use
[fleet-deployment.md](fleet-deployment.md).

## ASP preparation and runtime events

[aspd-headless-codex-integration.md](aspd-headless-codex-integration.md) records
the ASP preparation integration; it does not make its original Codex opt-in
rollout instructions a current native routing policy. The active producer
chooses execution preparation. Read back `.api.aspd.release` independently
of HRC's package tuple. Frozen workers/preparations retain their release
binding across aspd activation; retain any release they still reference.

Harness runtimes execute through the broker in the selected ASP preparation
release. Native HRC owns execution/lifecycle and consumes broker events. Use
`hrc monitor` and the durable `turn.message` / `turn.completed` events for
turn evidence; an accepted start response does not prove completion.
