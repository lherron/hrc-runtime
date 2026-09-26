# Install / publish split (T-08559)

Status: implemented design, revision 4. Daedalus approved the revision in
`EN-18147` on 2026-09-26.

## Purpose

An HRC node needs to select and run a committed release before that release is
ready for other projects to consume. `just install` therefore creates a local
atomic release candidate. `just publish` is the later, explicit transition that
makes the already selected candidate a canonical Verdaccio HRC package tuple.

The two operations have different authority:

| Operation | Authority | Result |
| --- | --- | --- |
| `just install` | local node | builds a committed `HEAD` into an atomic release and selects it; does not fetch containment or contact a registry |
| `just publish` | canonical HRC publisher | proves and publishes the selected release tuple under `latest` |
| `just install-dev` / `just publish-worktree` | local development worktree | may publish only the isolated `worktree` tag; cannot advance `latest` |

An installed or running tuple whose source is not yet on `origin/main` is a
local candidate. It is never evidence that the tuple is available from the
registry or suitable for fleet deployment.

## Local release selection

`just install` retains the dependency coherence, build, CLI entrypoint, atomic
selection, and release-manifest checks. It derives the release bytes from `git
archive HEAD`, so the stored `sourceCommit` describes the artifact even when
the checkout also contains unrelated local files. It mints the seven-field
`praesidiumBuild` tuple in the release manifest and atomically advances
`~/.bun/install/hrc-runtime-current` after the candidate is complete.

It neither fetches `origin/main` nor writes Verdaccio. A subsequent daemon
restart may run the local candidate. `hrc server status` can truthfully show its
source commit and `runningEqualsInstalled`; neither field claims publication.

## Canonical publication

`just publish [dry-run=1]` is the sole canonical registry writer. The private
recipe calls `scripts/publish-local-verdaccio.ts --selected-release`; callers
cannot supply a package root, build tuple, version, tag, source identity, or
replacement flag.

The publisher:

1. Takes the same durable install lock as release selection.
2. Captures the selected release and exact release manifest once.
3. Requires the release tuple source commit to equal checkout `HEAD`, freshly
   fetches the named canonical remote, and proves the commit is contained by
   `origin/main`.
4. Copies package directories to private temporary staging space, writes only
   the staged manifests, and packs from that copy. The selected release remains
   read-only.
5. Refuses a partial preexisting package set or a name/version replacement. A
   complete existing set is verified by cache-bypassed tarball readback and
   succeeds idempotently.
6. Rechecks the selected link and original manifest before reporting success.

The selected release's full build tuple is stamped verbatim into every package
manifest and compared against each published tarball. `hrcdev` continues to be
contained to its loopback registry, so it cannot publish a shared tuple.

## Deployment

`deploy-max3` runs the canonical publish step only after HRC has been selected,
restarted, and read back as the requested running release. This also happens on
the already-at fast path. `deploy-svc` and `deploy-hrcdev` use `no-publish` and
never advance the shared HRC tuple.

`deploy-fleet` first runs the max3 fast path with publication enabled for the
source commit observed from max3, then deploys that literal target to svc and
hrcdev. It cannot begin consumer deployment from an uncontained or unpublished
max3 candidate. Fleet parity remains `sourceCommit`, because every node mints a
local release version.

## Consumers and callers

agent-spaces may update HRC's ASP lock and build it, but does not publish HRC.
The owning HRC lane performs `just install` and, when canonical publication is
intended, `just publish` after the commit is pushed.

ACP continues to treat HRC `latest` as an advisory producer signal. It advances
its pinned HRC tuple only through its governed `advance-producers` flow after
the HRC publication exists. HRC local installation does not move ACP's tuple.

## Evidence

Focused automated coverage includes install-policy selection, the T-08559
recipe boundary, selected-release mutation/turnover detection, publisher
provenance, and the atomic-install continuity harness. Installed-node and ACP
consumer smoke remain the release acceptance steps.
