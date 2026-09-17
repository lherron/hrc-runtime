# Install / publish split (T-08559)

Status: proposed, revision 3 — resubmitted to Daedalus after EN-13001 (F1–F4) and
EN-13003 (F5, F6); EN-13005 FYI (F7, F8) folded in.

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

## Publication entrypoints (F5)

After this change the registry-writing surface of hrc-runtime is exactly two
commands, and `scripts/publish-local-verdaccio.ts` is the only code that writes
the registry:

| Command | Script invocation | Channel / tag | Law |
| --- | --- | --- | --- |
| `just publish [dry-run=1]` (main checkout) | `--channel canonical [--dry-run]` | canonical, `latest` | selected-release publication above |
| `just publish [dry-run=1]` (linked worktree) | `--channel worktree [--dry-run]` | non-canonical, `worktree` | worktree channel below |

The canonical law is enforced **inside the script**, not by the recipe: the
`--channel canonical` code path itself acquires the install lock, selects `R`,
runs the full tuple proof, stages, publishes, reads back and re-verifies. The
script accepts no argument or environment input that supplies a pack root, a
tuple, a source commit, a version, a tag, or `--force`. Removed from the CLI:
the default dev mode, `--version`, `--tag`, `--force`; removed from the
environment: `HRC_PUBLISH_SOURCE_ROOT`, `HRC_PUBLISH_EXPECTED_SOURCE_COMMIT`,
`HRC_PUBLISH_BUILT_AT`, `HRC_PUBLISH_BUILD_OUTPUT`, `HRC_PUBLISH_VERSION`.
`--channel` is required; any other invocation refuses before any registry or
lock access. A direct `bun scripts/publish-local-verdaccio.ts --channel
canonical` is therefore the same governed path as `just publish`.

Retired recipes (deleted, not aliased): `publish-canonical`,
`publish-canonical-dry-run`, `publish-dev`, `publish-dev-dry-run`,
`publish-semver`, `publish-semver-dry-run`, `publish-worktree`,
`publish-worktree-dry-run`. The dev and semver modes are retired rather than
left as "non-canonical": they stamp a `praesidiumBuild` tuple from an
uncontained checkout and move `latest`, which is indistinguishable in the
registry from a canonical set and is exactly what latest-following consumers
resolve (see *Consumers*).

`--dry-run` on the canonical path performs everything except registry writes and
read-back: lock, selection, full tuple and containment proof, staging, pack and
packed-manifest verification, the no-replacement check, and it reports whether
the real run would publish or be the idempotent no-op. It is the required
dry-run test surface.

Dependents updated with the retirement: `hrc-runtime.canonical-package-publication`
`required_tests` (`just publish-canonical-dry-run` → `just publish dry-run=1`);
`scripts/lib/publish-containment.ts` refusal remediation text;
`docs/wave-b-registry.md` publication commands and its "install may publish"
sentence; `docs/atomic-install.md`; `agent-loop/docs/dependency-consumption.md`
(its "`just publish-dev` in that repo" instruction, for hrc-runtime →
`just install` then `just publish`); the `publish-local-verdaccio` tests for
removed modes become CLI-refusal tests.

**Producer-owned caller (F7).** `agent-spaces/justfile` runs
`(cd "$hrc_runtime" && just pull-deps && bun run build && just publish-dev)` in
both its `install` downstream-sync branch and `sync-downstream`. That chain
depended on the dev mode publishing an uncontained, just-committed lock. Under
this law an HRC publication requires a pushed commit, which an ASP install must
not create on HRC's behalf. Both call sites become
`(cd "$hrc_runtime" && just pull-deps && bun run build)` followed by one line:
`[hrc-sync] hrc-runtime lock advanced to <asp version> at <sha>; publish with
just install && git push && just publish in hrc-runtime (or its deploy lane)`.
The adjacent comments (T-07727 note naming `publish-dev`) are rewritten to match.
Recipe-surface test on the HRC side already refuses the retired name; the ASP
change is verified by running `just sync-downstream` on max3 and confirming HRC's
lock commit lands and no publish is attempted.

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

## Consumers (F6)

Four repositories consume `hrc-*` packages from Verdaccio (inventory: every
`package.json` across the praesidium checkouts naming an `hrc-*` dependency —
agent-control-plane, agent-loop, signal-pipeline, taskboard); each is accounted
for by its own authority.

**agent-control-plane — pinned producer tuple.** Authority is
`agent-control-plane.asp-hrc-consumer-coherence` and `docs/producer-advance.md`:
HRC movement happens only through `just advance-producers set=hrc version=…`,
which derives membership from `praesidiumBuild`, requires every member at the
requested version, and re-proves containment against ACP's fixed canonical
remote. `pull-deps` never moves HRC. This change does not alter that mechanism;
it alters the producer premise the record names:

- The record's reopen condition "ASP/HRC publication stops minting latest as an
  install side effect or gains a release signal" fires for HRC. Review outcome:
  the predicate stands unchanged — `latest` stays advisory, and advance's own
  containment proof and tuple derivation do not depend on when HRC publishes.
  What changes is that every HRC set reachable at `latest` is now a canonical,
  selected-release set (dev/semver modes retired), and an HRC install no longer
  moves `latest`.
- Amendment in the ACP record: `reopen_when` replaces that item with "ASP
  publication stops minting latest as an install side effect, HRC publication
  becomes an install side effect again, or either gains a release signal";
  `authority` sources gain `wrkq:T-08559`; `last_verified` is set by the live
  acceptance below.
- Amendment in `docs/producer-advance.md` line 3: ASP's `just install`
  publishes a node-local set and moves `latest`; HRC publishes and moves
  `latest` only through explicit `just publish` (run by HRC deploy lanes).
  Neither is a release signal for ACP. Line 25's prohibitions are unchanged.

**agent-loop — follows `latest`.** `hrc-sdk: "latest"`, advanced by its
`just pull-deps` (`scripts/sync-hrc-sdk-from-verdaccio.ts`). Its guarantee gets
stronger: `latest` is now only ever written by the canonical path (contained
commit, selected release), where previously `publish-dev` could move it from an
uncontained checkout. The only change it sees is timing — a sibling change is
available after the producer's `just publish`, not its `just install`. Its doc is
in the dependents list above.

**signal-pipeline — exact pins** (`hrc-core`/`hrc-sdk`
`0.1.0-dev.20260822145920`). Hand-advanced; unaffected beyond the same timing.

**taskboard — exact pin under its own consumer record (F8).**
`apps/api` pins `hrc-sdk` `0.1.0-dev.20260725013259`; authority is
`taskboard.asp-hrc-consumer-coherence`, whose checker proves a coherent HRC
closure and the exact published `praesidiumBuild` tuple against cache-bypassed
registry bytes, and which imports `hrc-runtime.canonical-package-publication`.
Disposition: the imported predicate is retained (appended, not weakened), the
seven-field tuple and registry locator are unchanged, and the pinned version is
not moved — none of that record's `reopen_when` conditions fire. Its checker is
run unchanged as part of live acceptance (step 7) to confirm; no edit to the
taskboard record or code.

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

- A node can run a release that was never published. Consumers see the last
  published set until `just publish` (or a deploy lane) runs. This is the
  intended new state.
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

Entrypoints: the script refuses no `--channel`, `--version`, `--tag`,
`--force`, and each removed `HRC_PUBLISH_*` variable, before touching the lock
or registry; `justfile` contains no recipe invoking the publisher other than
`publish`, and none of the retired names (recipe-surface test).

Live (max3):

1. Commit without push → `just install` → `hrc server restart` → status
   `sourceCommit` == HEAD, `runningEqualsInstalled` true.
2. `just publish dry-run=1` and `just publish` refuse (uncontained); registry
   unchanged.
3. In agent-control-plane: `just advance-producers set=hrc version=<T.setVersion>
   --dry-run` refuses (version not published).
4. Push → `just publish dry-run=1` reports "would publish" → `just publish`
   succeeds; registry read-back == `T`; release tree byte-identical; second
   `just publish` is the no-op.
5. In agent-control-plane: `just advance-producers set=hrc version=<T.setVersion>
   --dry-run` succeeds, deriving the full HRC membership at `T.sourceCommit` and
   proving containment against ACP's canonical remote; tracked tree unchanged.
   `version=latest --dry-run` resolves the same version. (No real advance: that
   is a coordinated deployment window, outside this change.)
6. In agent-loop: `bun scripts/sync-hrc-sdk-from-verdaccio.ts` (read-only
   advisory mode) reports `latest` == `T.setVersion`.
7. In taskboard: its consumer-coherence checker exits 0 against its unchanged pin.
