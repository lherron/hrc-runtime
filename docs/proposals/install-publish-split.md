# Install / publish split (T-08559)

Status: proposed, revision 2 — resubmitted to Daedalus after EN-13001 (F1–F4).

## Problem

`just install` on the main checkout always ends in a canonical Verdaccio
publication (`scripts/atomic-install.ts` `prepareProductionRelease` →
`scripts/publish-local-verdaccio.ts --channel canonical`). The publication gate
(`provePublicationSource`, invariant `hrc-runtime.canonical-package-publication`)
refuses a `HEAD` not contained by freshly fetched `origin/main`. So every local
install requires a push, and a push runs the full pre-push validation hook, even
when the only goal is to activate a committed change on this node.

The containment gate is correct for what it guards: packages in the registry are
consumed across repositories (agent-control-plane pins `hrc-*` versions from
Verdaccio and re-proves containment before advancing), so a package whose
`sourceCommit` is later amended or rebased away must never enter the registry.
It is not needed for a local release, whose consumer is this node's own CLI
wrappers and daemon.

## Identity that is law

Publication binds to the **selected installed release**: the release directory
`hrc-runtime-current` resolves to, read once under the install lock, and held
for the entire publication (see *Selection and serialization*). Publication
does **not** assert anything about the running daemon. Registry consumers need a
contained commit and a tuple that names bytes produced by a real atomic build;
whether some node's daemon has restarted onto that release is not a property of
the package set. Where a caller also needs running identity (deploy lanes), it
proves it with its own gate before publishing (see *Callers*).

## `just install` — local atomic release

1. Unchanged guards: `install-dirty-guard`, `check-lock-coherence`,
   `check-asp-skew --warn`, the install lock. The `assertPublishContainment`
   node refusal moves to publish (install never writes a registry).
2. Source proof (new `proveInstallSource`): clean source tree (same
   `partitionInstallScope` cut as today, untracked source counts), `HEAD` resolved
   to a 40-char commit, `canonicalRemote` = URL of the named canonical remote. No
   fetch, no containment check. A dirty source tree is refused as today.
3. Release is built from `git archive HEAD` exactly as today.
4. The installer, not the publisher, mints the HRC `praesidiumBuild` tuple:
   `createPraesidiumBuild({ canonicalRemote, sourceCommit, setVersion, builtAt })`
   with `setVersion = timestampVersion(base, 'dev')` and `builtAt` = build time.
   The seven-field tuple shape, its parser, `praesidium-release.json`, daemon
   capture and `runningEqualsInstalled` are unchanged. `setVersion` is the version
   the release will carry if published; install does not claim it has been.
5. Cutover as today. No registry write.

## `just publish` — publication of the selected installed release

### Selection and serialization (F4)

1. Acquire the **same** install lock (`~/.bun/install/hrc-runtime-install.lock/`)
   before anything else, and hold it until the read-back completes. Install and
   publish are mutually exclusive; the lock's refusal message names both verbs.
2. Under the lock, resolve `realpath(hrc-runtime-current)` once → release `R`.
   Parse `R/praesidium-release.json` → release manifest `M`, tuple `T = M.hrcBuild`.
   Every later read uses `R` by absolute path, never the `current` link.
3. Immediately before declaring success (after read-back), re-resolve
   `realpath(hrc-runtime-current)` and re-read `R/praesidium-release.json`; refuse
   unless the link still names `R` and the manifest is byte-identical to the one
   parsed in step 2. Under the lock this cannot differ; the check fails closed if
   the lock was bypassed.

### Complete tuple proof (F4)

Every field of `T` is bound, not only `sourceCommit`:

- `repository`, `setName`, `schema`: enforced by `parsePraesidiumBuild`.
- `sourceCommit`: must equal checkout `git rev-parse HEAD`; else refuse "install
  first".
- `canonicalRemote`: must equal `git remote get-url <remote>` of the named
  canonical ref's remote, read before the fetch **and** again after it; any
  mismatch (tuple vs remote, or before vs after) refuses as remote drift. The
  fetch itself targets the URL in `T`, not the remote name:
  `git fetch --prune <T.canonicalRemote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>`.
  Containment (`merge-base --is-ancestor T.sourceCommit <remote>/<branch>`) is
  therefore proved against exactly the remote the tuple names.
- `setVersion`, `builtAt`: stamped verbatim into every package manifest; the
  publisher mints nothing.
- Read-back: the existing cache-empty tarball read compares each package's
  registry `praesidiumBuild` to `T` by stable JSON (all seven fields).

Unchanged in the gate: clean source tree in the checkout, `assertPublishContainment`
(hrcdev loopback-only), same-name/version replacement refusal.

Idempotence: if every package at `T.setVersion` already exists and its
registry-read `praesidiumBuild` equals `T` exactly, publish succeeds as a no-op
(still under the full proof above). An existing version with any differing tuple
is refused as today.

### Publication never writes the release (F3)

The publisher treats `R` as read-only. For each package it copies
`R/packages/<pkg>` (excluding `node_modules`) into a private `mkdtemp` staging
directory, writes the publish manifest into the **staging** copy, and runs
`bun pm pack` there. Nothing under `R` is opened for write, so an interrupted
publish cannot leave a rewritten manifest in the release and no concurrent
reader of `R` observes a transient manifest. The internal-dependency pinning
already removes `workspace:` references, so packing outside the workspace is
self-contained; a test pins that.

The same staging applies to the linked-worktree channel, which today rewrites
the checkout's own `package.json` files in place.

What the registry then holds is "the files of release `R`'s package directories
at publication, under tuple `T`". Release immutability after cutover remains the
existing `observable-release` property; publication no longer weakens it.

## Linked worktrees

`just install` in a linked worktree (link-mode off) builds in the checkout and
publishes nothing. `just publish` in a linked worktree publishes the
`worktree` channel/tag from that checkout's build through private staging.
Worktree publication stays non-canonical and outside the release-selection rules.

## Callers (F1, F2)

`_deploy-node` (`deploy-svc`, `deploy-lab`, `deploy-max3`, `deploy-hrcdev`) orders
its steps so that publication is the **last** step on **every** successful path:

- **Changing deploy:** existing containment check → ff-merge → busy gate →
  `just install no-sync=1` → restart → existing readback (running `sourceCommit`
  == target, `runningEqualsInstalled == true`, supervisor ownership) →
  `just publish`. Publication runs only after the lane has proved the daemon runs
  the installed release, so on this path the published `R` is also the running
  release — proved by the lane's gate, not claimed by publish.
- **Fast path** ("already at": checkout HEAD, running `sourceCommit` and
  installed release all equal the target): runs `just publish` before exiting
  instead of `exit 0`. A node that installed an unpushed commit locally and was
  pushed later therefore gets published by the next deploy; an already-published
  release is the idempotent no-op. "Already deployed" again implies "published".
- hrcdev keeps `VERDACCIO_REGISTRY=http://127.0.0.1:4873/` on the publish
  invocation (it previously rode the install invocation).

`deploy-fleet-from-max3` targets max3's running `sourceCommit`; an unpushed max3
install is refused by `_deploy-node`'s containment check. `fleet-status` reports
parity by `sourceCommit`; unchanged.

Agent doctrine ("push once right before the delivery install") becomes "install
needs a commit; publish needs a push".

## Invariant changes

`hrc-runtime.canonical-package-publication` — predicate text retained; append:
"A canonical package set is published only from the atomic release selected as
current under the install lock, held for the whole publication and re-verified
before success; it carries that release's complete HRC build tuple verbatim,
whose canonicalRemote is the URL fetched for the containment proof. Publication
never writes the release directory, and installation never writes a registry."
Sources gain `scripts/atomic-install.ts`; required tests gain the new publish
tests below.

`hrc-runtime.observable-release` — predicate retained; append: "The recorded HRC
build may name a commit not yet contained by the canonical ref; publication reads
a release and never mutates it."

`docs/atomic-install.md` "Main-checkout atomic installs are canonical
publications" paragraph is rewritten to the above.

## Consequences

- A node can run a release that was never published. Downstream consumers
  (ACP `pull-deps`) see the last published set until `just publish` (or a deploy
  lane) runs. This is the intended new state.
- `hrc server status` can show a `sourceCommit` absent from origin; it cannot
  enter the registry.
- Install gets faster by the pack/verify/publish time; publish never builds.
- Publish contends for the install lock; a concurrent install/publish refuses
  immediately rather than waiting, as installs do today.

## Tests

Publisher (`publish-local-verdaccio.test.ts` / new `publish-release.test.ts`):

- uncontained commit refused (unchanged);
- `release.sourceCommit != HEAD` refused ("install first");
- remote drift refused: tuple `canonicalRemote` ≠ remote URL; URL changed between
  pre- and post-fetch reads; fetch proven to target the tuple URL;
- publish stamps `T` verbatim (all seven fields) and read-back compares all seven;
- idempotent re-publish no-op; differing tuple at existing version refused;
- release tree is byte-identical before and after a successful publish **and**
  after a publish killed mid-pack (fault injected after the staging manifest write);
- publish refuses while the install lock is held; install refuses while publish
  holds it;
- `current` re-pointed to another release during publish (lock bypassed in the
  fixture) → refused at the final re-verification.

Install (`atomic-install` tests): an unpushed clean commit installs, writes a
valid release manifest with a minted tuple, and invokes no publisher.

Deploy lane: fast path invokes publish before exit; changing path invokes
publish only after the post-restart readback (asserted by recipe-order test).

Live: commit without push → `just install` → `hrc server restart` → status
`sourceCommit` == HEAD; `just publish` refused (uncontained); push → `just publish`
succeeds, registry read-back == release tuple, release tree unchanged; second
`just publish` no-op; ACP `pull-deps` resolves the version.
