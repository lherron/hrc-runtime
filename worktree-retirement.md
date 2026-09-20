---
name: worktree-retirement
description: Audit and safely retire Praesidium worktrees, standalone clones, and task artifacts under under-construction after proving their changes are preserved upstream and that no live runtime still uses them. Use for inventory, cleanup planning, or an explicitly authorized retirement pass; do not use for ordinary branch deletion or arbitrary directory cleanup.
---

# Worktree Retirement

Retire obsolete material under `~/praesidium/under-construction` without losing
source changes, task evidence, or a workspace still used by a live process. Use a
deterministic helper script for discovery, grading, and mutation. Use agent judgment
only for histories or artifacts the script marks for review.

The fixed point is not an empty directory. It is a durable audit showing why every
removed path was safe, followed by an apply readback showing that the approved paths
were removed or quarantined and every held path remained untouched.

## Authority boundary

An inventory or audit request authorizes read-only inspection and fetching remote Git
refs. It does not authorize removal. Run the apply phase only when the user explicitly
asks to delete or retire the approved paths.

Never broaden approval from one named path or manifest to the whole
`under-construction` tree. Never treat a completed task, an old timestamp, a clean
worktree, or an empty command result as proof that work was merged.

## Required implementation

Keep the repeatable mechanics in `scripts/worktree-retirement.sh`. The script should
have separate `audit`, `explain`, and `apply` modes and should emit machine-readable
JSON as well as a concise table. The script, rather than the agent, owns every
mechanical deletion gate.

Suggested interface:

```sh
scripts/worktree-retirement.sh audit \
  --root /Users/lherron/praesidium/under-construction \
  --fetch \
  --output /absolute/path/to/audit.json

scripts/worktree-retirement.sh explain \
  --report /absolute/path/to/audit.json

scripts/worktree-retirement.sh apply \
  --manifest /absolute/path/to/approved.json \
  --revalidate \
  --trash
```

Audit is the default behavior when no mutating mode is named. Apply must require both
an explicit approved manifest and `--revalidate`; it must not offer an option that
skips safety checks. A future implementation may choose a different flag spelling,
but it must preserve these mode and authority boundaries.

## Sequence

Work in this order because each leg removes uncertainty needed by the next:

1. Discover and classify every candidate, including nested Git repositories.
2. Refresh the authoritative upstream refs for each owning repository.
3. Reject dirty, active, locked, stale, or structurally ambiguous candidates.
4. Prove preservation by ancestry or patch equivalence where Git can do so
   mechanically.
5. Review unmatched or non-Git material and record the evidence for each ruling.
6. Produce an exact approved manifest; do not delete directly from an audit result.
7. Revalidate each manifest entry immediately before touching it.
8. Remove registered worktrees through Git and quarantine other approved paths.
9. Read back the filesystem and Git worktree registry, then retain the audit and apply
   results.

Discovery and remote fetches may run in parallel by owning repository. Review must
wait for fetched refs. Apply must operate one exact path at a time so a failure cannot
hide which paths changed.

Treat an owner's current, exhaustive keep list as a path allowlist, not as permission
to preserve every entry associated with that owner or product. Record separately any
additional path held by a mechanical safety gate, with the exact observation that
keeps it live. Recheck transient liveness after the dependent process exits; a
temporary hold must not silently become permanent scope expansion.

## Discovery and classification

Enumerate every direct child of the cleanup root before recursively locating `.git`
files and directories. Include ordinary files and symlinks: a directory-only walk can
silently omit live-checkout symlinks and metadata files. Do not assume every top-level
entry is a worktree, and do not stop after examining only direct children of the root.

Classify each candidate as exactly one of:

- `linked_worktree`: a registered worktree whose `.git` file resolves into another
  repository's common Git directory.
- `standalone_clone`: a repository with its own `.git` directory.
- `container_with_nested_repo`: a non-repository directory containing one or more Git
  roots.
- `embedded_repository`: a Git root nested inside another candidate, such as a
  fetched dependency clone. Grade it as part of its parent rather than treating it as
  an independently retireable peer.
- `generated_artifact`: a recognized install prefix, build output, smoke fixture, or
  scratch product whose structure matches an explicit rule.
- `symlink`: a direct entry whose link and resolved target are recorded but never
  followed for cleanup.
- `ordinary_file`: a direct non-directory entry.
- `unknown`: anything not proven to fit another class.

`symlink`, `ordinary_file`, and `unknown` are held unless the user separately names the
exact entry for removal. A parent candidate cannot be approved while an embedded
repository, enclosed repository, or unknown child remains ungraded. A dirty or
unpreserved embedded repository blocks removal of its parent.

For every Git root record:

- absolute and real paths;
- repository common directory and canonical checkout;
- whether Git's worktree registry contains the path and whether it is locked or
  prunable;
- branch name or detached state;
- HEAD SHA;
- configured remotes, upstream, and resolved remote default branch;
- tracked, untracked, ignored, and submodule state;
- ahead/behind counts and unique commits;
- inferred task ID, if the path contains one;
- live-use observations;
- verdict and explicit reason codes.

Use NUL-delimited filesystem and Git output internally. Paths may contain whitespace.
Resolve paths without following an untrusted final symlink during mutation.

## Establish the comparison target

Group linked worktrees by common Git directory. From the canonical checkout, fetch
each relevant remote once with pruning enabled. Resolve the preservation target from
the remote's symbolic default integration branch. When the user asks whether work is
merged to main, compare explicitly with that remote's `main`; a configured feature
upstream proves remote backup, not integration. Record a worktree's configured upstream
as supplementary evidence only. Compare against it instead of the integration branch
only when the user explicitly defines preservation on that branch as sufficient. Do
not assume that every repository names its integration branch `origin/main`.

Record both the remote URL and fetched target SHA. A missing remote, fetch failure,
ambiguous upstream, shallow history that prevents comparison, or command failure is a
`HOLD`. Never continue with a stale local ref while reporting it as current.

Do not suppress exit codes with `|| true` in a grading path. Capture stdout, stderr,
and exit status immediately, before another command or shell assignment can obscure
it. Avoid shell-special variables such as zsh's read-only `status` and its `path`
array, which is tied to `PATH`; use task-specific names such as `fetch_rc` and
`candidate_path`. Empty output is evidence only when the command succeeded and the
command contract says emptiness is meaningful.

## Cleanliness gate

Use `git status --porcelain=v2 -z --untracked-files=all` and inspect submodules rather
than relying on a human-formatted status. Any tracked modification, staged change,
conflict, untracked file, or submodule delta is a `HOLD` until the material is
preserved or deliberately discarded under separate authority.

Ignored content needs classification rather than a blanket ruling. Known disposable
caches such as dependency directories and compiler output may be allowed. Unknown
ignored top-level content and likely state-bearing material such as environment files,
databases, credentials, exports, or evidence bundles require review. Record ignored
content by top-level path and size without printing secrets.

Do not create a commit, stash, patch, or branch merely to make a candidate clean unless
the user separately asks to preserve that material in that form.

## Git preservation grades

Assign one of these grades after a successful fetch and cleanliness check:

### `SAFE_ANCESTRY`

`git merge-base --is-ancestor HEAD <target>` succeeds. The exact worktree commit is
reachable from the freshly fetched target.

### `SAFE_PATCH_EQUIVALENT`

HEAD is not an ancestor, but every non-merge commit unique to the worktree is reported
as patch-equivalent upstream, and there are no unique merge commits or unexplained tree
deltas. Record the matching patch IDs or upstream commits.

`git cherry` ignores merge commits and does not prove arbitrary squash equivalence.
Therefore an empty or all-minus result is insufficient when the unique range contains
a merge commit. Command success must be checked before interpreting its output.

### `REVIEW`

Use this grade when history was squashed, rebased with changed patches, contains unique
merge commits, has unmatched commits, or otherwise cannot be proven mechanically.
Review:

```sh
git log --graph --decorate --oneline <target>..HEAD
git log --cherry-pick --right-only --no-merges <target>...HEAD
git cherry <target> HEAD
git range-diff <merge-base>..HEAD <merge-base>..<target>
git diff --stat <merge-base>..HEAD
git diff <merge-base>..HEAD
```

Adapt the range when the likely landing commit or merge base is known. Inspect merge
commit conflict-resolution deltas separately. For a squash, identify the actual
upstream commit and show that it preserves the branch's intended file changes; do not
approve solely because commit messages or task IDs match.

The associated wrkq record can establish intent, ownership, and claimed landing SHA.
Read its final evidence when a task ID is available. A task in `open`, `in_progress`,
or `blocked` is a `HOLD`. A completed task is supporting evidence, not proof of Git
containment. A cancelled task is not automatically disposable: read the cancellation
rationale and prove that its unique changes are obsolete or superseded before approval.

Record a concise review ruling that names the upstream artifact preserving the work.
If that mapping cannot be made confidently, retain the worktree.

### `HOLD`

Use `HOLD` for any dirty, active, locked, stale, failed, ambiguous, or unexplained
state. Include one or more reason codes and the next observation that could clear each
reason. Holding a candidate is a successful audit outcome, not a reason to weaken a
gate.

## Live-use gate

Before approval and again immediately before removal, prove that the path is not in
use. Check at least:

- local HRC runtime and session projections for workspace, checkout, cwd, or launch
  paths beneath the candidate;
- process current-working-directories and open files beneath the candidate;
- tmux pane current paths;
- Git worktree locks;
- any repository-specific lease or task-run marker discovered during classification.

Use installed operator surfaces for HRC observations, but first confirm which path
fields they actually expose. An HRC projection that omits cwd or workspace paths cannot
prove that no runtime uses a candidate. Local process-cwd/open-file inspection and tmux
pane paths are the authoritative local path-use checks when HRC lacks those fields. Do
not restart, interrupt, recover, or otherwise mutate a runtime merely to make cleanup
possible. An unavailable required liveness source makes apply fail closed for affected
candidates.

An inactive historical HRC record may be noted without blocking when no resumable or
live runtime depends on the path. A live or uncertain reference is a `HOLD`.

## Non-Git artifacts

Merge ancestry does not apply to install prefixes, smoke fixtures, scratch directories,
or evidence bundles. Grade them by provenance and live use instead.

Automatic classification must depend on recognized structure, not just a permissive
name glob. For example, an install prefix may be recognized from its expected manifest
plus `bin`/`lib` layout; a smoke fixture may be recognized from the creating task's
known output layout. Names such as `scratch`, `install`, or a task ID alone are not
proof.

For each artifact record:

- producer task or command when inferable;
- structural rule that matched;
- nested repositories or source-like unknown content;
- size and modification time;
- task state;
- live-use result;
- whether any durable task evidence refers to the path.

An artifact may enter the approved manifest only when it has no ungraded nested
repository, no live user, no unexpected state-bearing content, and an explicit
provenance ruling. Evidence directories referenced by an unfinished review remain held.

## Audit report and approval manifest

The audit JSON should include:

```json
{
  "schemaVersion": 1,
  "root": "/absolute/root",
  "auditedAt": "RFC3339 timestamp",
  "repositories": [],
  "candidates": [],
  "summary": {
    "safeAncestry": 0,
    "safePatchEquivalent": 0,
    "review": 0,
    "hold": 0
  }
}
```

Each candidate needs its exact path, class, evidence, live-use observations, filesystem
identity, verdict, and reason codes. Git candidates also need common-directory, HEAD,
target, cleanliness, and unique-history fields.

The human table should make the unsafe cases easiest to see:

```text
VERDICT  CLASS             PATH                 HEAD       TARGET     REASONS
HOLD     linked_worktree   .../example          abc1234    def5678    dirty,live
REVIEW   standalone_clone  .../squashed-copy    123abcd    789ef01    unmatched-history
```

Do not mutate directly from the audit report. Create a separate manifest containing
only explicitly approved candidate records and their audit fingerprints. Preserve the
original report unchanged so the decision remains auditable.

## Apply safeguards

Before applying a manifest:

1. Resolve the configured root and candidate path to absolute paths.
2. Refuse the root itself, its ancestors, symlinks that escape it, globs, empty paths,
   and candidates outside the root.
3. Require the candidate's current filesystem identity to match the manifest.
4. Repeat discovery, Git cleanliness, fetched-target, task-state, lock, nested-repo,
   and live-use checks.
5. Require current HEAD and status fingerprint to match the approved record.
6. Stop that candidate on any mismatch and continue only according to an explicit
   per-entry failure policy; never reinterpret a mismatch as approval.

When the shell uses `set -e`, wrap expected-negative checks such as “registry entry is
absent” in an `if` statement or capture their status in a context exempt from errexit.
An expected nonzero result must not abort the remaining readback.

For a registered linked worktree, invoke `git worktree remove <exact-path>` from its
owning repository without `--force`. Afterwards, confirm the path is absent and the
worktree registry no longer lists it. Do not run repository-global `git worktree
prune` as part of scoped cleanup: it can remove stale registrations outside the
approved root. Any unrelated prunable entry requires separate inventory and authority.

If a registered linked worktree is approved for retirement but still contains local
state worth preserving—dirty files, nested repositories, ignored evidence, or an
otherwise uncertain payload—quarantine it with `git worktree move <exact-path>
<quarantine-path>` from its owning repository instead of forcing removal or moving it
behind Git's back. Confirm both that the original path is absent and that the owning
repository's worktree registry names the quarantine destination. This produces a clean
active root while retaining the worktree's HEAD, branch attachment, local files, and
registry identity for recovery or later review.

Do not delete the associated branch during worktree retirement. Keeping the branch is
a cheap recovery path and branch cleanup is a separate decision.

For an approved standalone clone or non-Git artifact, move the exact path into a
timestamped quarantine directory under the current user's Trash. Preserve the original
basename and write a small manifest mapping original paths to quarantine paths. Do not
use `rm -rf`, `find -delete`, or automatic Trash emptying.

If a move crosses filesystems and cannot be atomic, stop and report it rather than
silently copying and deleting. Permanent purge is a later operator action after an
appropriate retention period.

## Readback and recovery

After apply, emit a second JSON document containing, for every approved entry:

- `removed`, `quarantined`, `held`, or `failed`;
- the preflight fingerprint and revalidation result;
- the exact Git or filesystem operation performed;
- the quarantine destination when applicable;
- post-operation filesystem and worktree-registry observations;
- stderr and exit status for failures.

Success means every removed linked worktree is absent from both disk and its Git
registry, every quarantined item exists at its recorded destination, and every held or
failed candidate still exists at its original path. A partial apply is reported as
partial, never summarized as complete.

Recovery is intentionally simple:

- recreate a linked worktree from its retained commit or branch;
- move a quarantined linked worktree back with `git worktree move`, using its owning
  repository and the destination recorded in the apply report;
- move a quarantined standalone clone or artifact back to its recorded original path;
- consult the unchanged audit and apply reports for the exact prior identity.

## Agent conduct

Lead with the bearing: how many candidates are mechanically safe, need review, or must
be held. Explain review rulings from durable Git, wrkq, HRC, process, and filesystem
readback rather than worker self-report.

Do not turn observations into backlog tasks merely because cleanup found them. If an
unmerged change is small and the user asks to preserve or land it, handle that as a
separate scoped operation. If it is substantial, report the dependency and recommend a
properly specified task without deleting the source worktree.

When deletion is authorized, present the exact approved set and quarantine behavior
before apply. Afterward, report removed, quarantined, held, and failed counts, naming
every exception.
