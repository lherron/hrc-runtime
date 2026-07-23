# Verdaccio single-authority contract

Status: current as of 2026-07-23. This document supersedes every prior Wave B
assumption about node-local Verdaccio stores, cross-store mirroring, or max3 as
a registry authority.

## Authority and topology

Praesidium repositories exchange ASP, HRC, ACP, and wrkq boundary packages as
immutable versions through one canonical registry:

```text
http://mini:4873/
```

Mini hosts the only Verdaccio service and writable package store. The service
is operationally owned by `svc`. Every consumer and publisher on `svc`, `lab`,
and `max3` uses the canonical mini endpoint; no independent registry is an
authorized source or publish target.

Physical co-hosting does not change logical-node identity. `svc` and `lab` run
on mini but remain separate logical nodes with separate users, roots, runtime
state, placement authority, and credentials. Never infer HRC node identity from
the registry hostname, URL, or network address.

Uplinks remain disabled for Praesidium boundary packages. Missing boundary
packages fail closed instead of silently resolving different content from the
public npm registry.

## Publication and consumption

Publisher repositories create coherent timestamped development snapshots:

- agent-spaces publishes one version across the complete ASP package set;
- hrc-runtime publishes one version across its HRC package set;
- wrkq publishes the corresponding immutable `@wrkq/client` version;
- agent-control-plane publishes its ACP package set.

Publish each coherent set once to mini. All checkout-local `.npmrc` files,
publisher defaults, and sync defaults select `http://mini:4873/`. Publication
credentials remain in user configuration and must never be committed.

There is no exact-store mirroring, cross-store reconciliation, or historical
equivalence gate. A pushed lock is satisfiable when its immutable package
versions exist in the canonical mini store. Do not rerun a
timestamp-generating producer install merely to create a second copy on
another node.

Publication, lockfile selection, installation, and daemon activation are
separate states:

1. Publish the coherent package set to mini.
2. Select and commit exact package versions in the consumer lock.
3. Install/build from that pushed source and lock.
4. Install the owning runtime release.
5. Restart the affected daemon and verify its installed release and health.

The repository-owned publication commands enforce package-set coherence and
safe packed manifests:

```bash
just publish-dev-dry-run
just publish-dev
```

Main-checkout `just install` may publish as part of the repository lifecycle.
Linked worktrees retain their isolated publication channel unless an operator
explicitly requests a cutover.

## Canonical service supervision

The canonical source for mini's logout- and reboot-durable service is:

```text
launchd/com.praesidium.verdaccio.plist
```

It is a system-domain LaunchDaemon with label
`com.praesidium.verdaccio`, running as `lherron:staff`. The installed path is:

```text
/Library/LaunchDaemons/com.praesidium.verdaccio.plist
```

The service uses mini's existing config, auth, and storage:

```text
/Users/lherron/.config/verdaccio/config.yaml
/Users/lherron/.config/verdaccio/htpasswd
/Users/lherron/.local/share/verdaccio/storage
```

The plist sets `VERDACCIO_PUBLIC_URL=http://mini:4873`, so package metadata and
tarball URLs advertise the canonical network endpoint instead of loopback.

Installing or modifying a system-domain LaunchDaemon requires root. Validate
and stage the system definition before disturbing the live GUI LaunchAgent:

```bash
plutil -lint launchd/com.praesidium.verdaccio.plist
sudo install -m 644 -o root -g wheel \
  launchd/com.praesidium.verdaccio.plist \
  /Library/LaunchDaemons/com.praesidium.verdaccio.plist
sudo plutil -lint /Library/LaunchDaemons/com.praesidium.verdaccio.plist
```

Port 4873 cannot be owned by both jobs. Do not boot out the old GUI job until
the system plist is installed and validated. Preserve its plist as rollback
material during the handoff:

```bash
launchctl print gui/501/com.lherron.verdaccio
launchctl bootout gui/501/com.lherron.verdaccio
sudo launchctl bootstrap system \
  /Library/LaunchDaemons/com.praesidium.verdaccio.plist
```

Require the system job and canonical endpoint to be healthy before removing
the old GUI LaunchAgent plist:

```bash
sudo launchctl print system/com.praesidium.verdaccio
lsof -nP -iTCP:4873 -sTCP:LISTEN
curl -fsS http://mini:4873/-/ping
rm /Users/lherron/Library/LaunchAgents/com.lherron.verdaccio.plist
```

If the system job does not become healthy, boot it out and bootstrap the
preserved GUI plist as rollback. Do not remove the GUI plist or modify
config/auth/storage during a failed cutover.

## Verification

Verify the canonical endpoint from `svc`, `lab`, and `max3`:

```bash
curl -fsS http://mini:4873/-/ping
npm view <package>@<exact-version> version \
  --registry http://mini:4873/
bun install --frozen-lockfile
```

For existing packages, verify metadata and tarball URLs name `mini:4873` and
never loopback. Preserve and compare the complete pre-cutover and post-cutover
dist-tag maps. An authenticated throwaway publish/view/unpublish round-trip is
the publish-authority proof; use user-scoped credentials without printing them.

For runtime-affecting dependency changes, follow installation with the owning
service restart and real status readback. A successful registry query or build
does not prove the daemon is running the selected package release.

## Max3 retirement and recovery

The max3 Verdaccio service and global installation were retired on 2026-07-23.
Its verified cold recovery archive is:

```text
/Users/lherron/praesidium/var/backups/verdaccio-retired/20260723T201530Z/max3-verdaccio-cold.tar
```

SHA-256:

```text
d982c7e47274298d91db9f98963f8339fa0851407941f581b26076d3cd96fc08
```

The archive is recovery evidence only. It is not imported into mini, compared
for historical equivalence, or used as an automatic fallback registry.

TrueNAS backup is explicitly deferred. Until that work lands, mini-local disk
holds both the live canonical store and the retired max3 archive. Lance accepts
the temporary risk that loss of mini's disk can lose both. Do not claim remote
backup durability that has not been implemented and verified.
