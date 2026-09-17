# Install / publish split (T-08559)

Status: proposed — awaiting Daedalus.

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
Verdaccio), so a package whose `sourceCommit` is later amended or rebased away
must never enter the registry. It is not needed for a local release, whose
consumer is this node's own CLI wrappers and daemon.

## Decision

Two verbs, two gates.

### `just install` — local atomic release

1. Unchanged guards: `install-dirty-guard`, `check-lock-coherence`,
   `check-asp-skew --warn`, the install lock. The `assertPublishContainment`
   node refusal moves to publish (install never writes a registry).
2. Source proof (new `proveInstallSource`): clean source tree (same
   `partitionInstallScope` cut as today, untracked source counts), `HEAD` resolved
   to a 40-char commit, `canonicalRemote` read from the named remote's URL. No
   fetch, no containment check. A detached HEAD or a commit on any branch is
   accepted; a dirty source tree is refused as today.
3. Release is built from `git archive HEAD` exactly as today.
4. The installer, not the publisher, mints the HRC `praesidiumBuild` tuple:
   `createPraesidiumBuild({ canonicalRemote, sourceCommit, setVersion, builtAt })`
   with `setVersion = timestampVersion(base, 'dev')` and `builtAt` = the build
   time. The seven-field tuple shape, its parser, the release manifest
   (`praesidium-release.json`), daemon capture and `runningEqualsInstalled` are
   unchanged. `setVersion` is the version this release will carry if it is ever
   published; install does not claim it has been.
5. Cutover as today.

### `just publish` — Verdaccio publication of an installed release

1. Reads the current release (`hrc-runtime-current` → `praesidium-release.json`).
   Refuses unless `release.hrcBuild.sourceCommit == git rev-parse HEAD` of the
   checkout ("install first"). What is published is therefore the exact bytes and
   tuple this node runs; there is no second build.
2. Runs the **unchanged** canonical gate in the checkout: fresh fetch of
   `HRC_CANONICAL_REF`, clean source tree, `HEAD` contained by the ref,
   `assertPublishContainment` (hrcdev loopback-only).
3. Runs `publish-local-verdaccio.ts --channel canonical` with the release
   directory as the pack root and the release's own `hrcBuild` (`setVersion`,
   `builtAt`, `sourceCommit`, `canonicalRemote`) passed through — the publisher
   stamps that tuple verbatim instead of minting one. The existing
   no-replacement refusal and cache-empty tarball read-back are unchanged.
4. Idempotence: if every package at `setVersion` already exists and its
   registry-read `praesidiumBuild` equals the release tuple exactly, publish
   succeeds as a no-op. Any existing version with a differing tuple is refused as
   today.

### Linked worktrees

`just install` in a linked worktree (link-mode off) builds in the checkout and
publishes nothing. `just publish` in a linked worktree publishes the
`worktree` channel/tag from that checkout's build, as the unlinked install does
today. Worktree publication stays non-canonical.

### Callers

- `_deploy-node` (`deploy-svc`, `deploy-lab`, `deploy-max3`, `deploy-hrcdev`)
  runs `just install no-sync=1 && just publish`, preserving today's per-node
  registry contents. Its pre-move containment check stays.
- `deploy-fleet-from-max3` targets max3's running `sourceCommit`; an unpushed
  max3 install is refused by the existing containment check in `_deploy-node`.
  No change.
- `fleet-status` reports parity by `sourceCommit` as today; no change.
- Agent doctrine ("push once right before the delivery install") becomes
  "install needs a commit; publish needs a push".

## Invariant changes

`hrc-runtime.canonical-package-publication` — predicate text unchanged; add:
"A canonical package set is published only from an installed atomic release
whose HRC build tuple it carries verbatim; installation alone never writes a
registry." Sources gain `scripts/atomic-install.ts`.

`hrc-runtime.observable-release` — predicate unchanged. The recorded HRC build
may name a commit not yet contained by the canonical ref; release identity is
the commit and tuple, not publication state.

`docs/atomic-install.md` "Main-checkout atomic installs are canonical
publications" paragraph is rewritten to the above.

## Consequences

- A node can run a release that was never published. Downstream consumers
  (ACP `pull-deps`) see the last *published* set until `just publish` runs. This
  is the intended new state.
- `hrc server status` can show a `sourceCommit` absent from origin. That is
  observable (git), not ambiguous, and cannot enter the registry.
- Install gets faster by the pack/verify/publish time; publish no longer builds.

## Tests

- `publish-local-verdaccio.test.ts`: uncontained commit still refused (unchanged);
  publish with a supplied tuple stamps it verbatim; idempotent re-publish no-op;
  differing tuple at an existing version refused.
- New atomic-install test: an unpushed clean commit installs, writes a valid
  release manifest, and invokes no publisher.
- New publish test: `sourceCommit != HEAD` refused with "install first".
- Live: commit without push → `just install` → `hrc server restart` → status
  `sourceCommit` == HEAD; `just publish` refused; push; `just publish` succeeds
  and registry read-back matches the release tuple; ACP `pull-deps` resolves it.
