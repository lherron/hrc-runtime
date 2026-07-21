# Verdaccio artifact distribution contract

Status: current as of 2026-07-21. This document supersedes the original Wave B0
assumption that max3 hosted the only development registry and that mini was not
a consumer.

## Purpose and topology

Praesidium repositories exchange ASP, HRC, ACP, and wrkq boundary packages as
immutable versions through Verdaccio. Publisher scripts default to loopback:

```text
http://127.0.0.1:4873/
```

Consumer endpoints are checkout configuration, not a universal fleet constant.
The current HRC checkout uses the tailnet endpoint `http://mini:4873/`, while
ACP, taskboard, and agent-loop use loopback Verdaccio on their execution node.
The mini and max3 registry stores are distinct. A lockfile can therefore name a
valid version that is absent from the store serving the checkout that runs
`bun install`.

Registry topology is independent of HRC logical-node identity. In particular,
`svc` and `lab` can be co-hosted while retaining distinct users, roots, ports,
tokens, databases, and install prefixes. Never infer node identity from the
Verdaccio endpoint, hostname, or IP address.

Uplinks remain disabled for Praesidium boundary packages. A missing package is
supposed to fail closed rather than silently resolve different content from
the public npm registry.

## Publication and mirroring

Publisher repositories create coherent timestamped development snapshots:

- agent-spaces publishes one version across the complete ASP package set;
- hrc-runtime publishes one version across its HRC package set;
- wrkq publishes the corresponding immutable `@wrkq/client` version;
- agent-control-plane publishes its ACP package set.

Publication, lockfile selection, installation, and daemon restart are separate
states. The fleet contract is:

1. Publish the coherent package set once in the producer environment.
2. Record the exact package names and versions selected by consumer locks.
3. Mirror those exact immutable tarballs into every registry store that must
   satisfy the lock.
4. Install/build from the same pushed source and lock on each target node.
5. Restart affected launchd services and verify their reported binary/package
   paths and federation health.

Do not rerun a producer's timestamp-generating `just install` independently on
every node merely to populate its registry. That creates different package
versions and obscures whether the fleet is running the same artifact. A
lockfile alone is also insufficient: the named tarball must exist locally.

The repository-owned publication commands enforce package-set coherence and
safe packed manifests. Use them instead of hand-editing package manifests or
publishing packages one at a time:

```bash
just publish-dev-dry-run
just publish-dev
```

Main-checkout `just install` may include publication as part of that
repository's lifecycle. Linked worktrees use isolated channels and normally do
not repoint global wrappers or synchronize downstream consumers.

## Consumer configuration

Praesidium repositories use a repo-local `.npmrc` that selects the intended
artifact store. Several boundary packages are unscoped, so the selected
Verdaccio is the default registry and public third-party scopes are explicitly
routed to npmjs where needed. Two current endpoint shapes are:

```ini
# Node-local consumer store (ACP, taskboard, agent-loop)
registry=http://127.0.0.1:4873/
//127.0.0.1:4873/:_authToken=<NODE_LOCAL_PUBLISH_TOKEN>
fetch-retries=0

# Or the shared mini store used by HRC checkouts
# registry=http://mini:4873/

@types:registry=https://registry.npmjs.org/
@anthropic-ai:registry=https://registry.npmjs.org/
```

Read access can be open on loopback; publication credentials remain node-local
and must not be committed. Consult that node's service inventory for its
Verdaccio supervisor, config, storage, and logs. The historical max3 service
uses `com.lherron.verdaccio`; do not assume that label identifies every
registry installation.

## Verification

Verify health and the exact required versions before installing a consumer
lock:

```bash
curl -fsS http://127.0.0.1:4873/-/ping
npm view <package>@<exact-version> version \
  --registry http://127.0.0.1:4873/
bun install --frozen-lockfile
```

For runtime-affecting changes, follow installation with the owning service
restart and real status readback. HRC must report the selected atomic release
in `binaryPath` / `packagePath`; a successful package query or build does not
prove the daemon is running it.
