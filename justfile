# Agent Spaces v2 justfile

# Default recipe
default:
    @just info
    @just --list

# Project information
info:
    @echo "Current Project: spaces"
    @echo "Description: Composable expertise modules, ASP registry"
    @echo "Stack:       TypeScript (Bun workspace)"
    @echo ""
    @echo "Key commands:"
    @echo "  just build     - Build all packages"
    @echo "  just test      - Run tests"
    @echo "  just lint      - Run biome linter"
    @echo "  just verify    - Declared landing gate: env-up + check + lint + typecheck + test"
    @echo "  just install   - Atomic install; refuses a dirty tree unless allow-dirty=1"
    @echo "  just env-up    - Provision the ephemeral daemon + fixture agent homes"
    @echo "  just env-down  - Tear that environment down"
    @echo "  just e2e       - Run the suite against the provisioned environment"
    @echo "  just serve-docs - Serve docs/html on 0.0.0.0:18481"

# Build all packages
build:
    bun run build

# Run tests
test:
    bun run test

test-unit:
    bun run test:unit

test-contract:
    bun run test:contract

# Full server fixture suite; required for release qualification, not pre-push.
release-test:
    bun run test:release

# Report authored-test source pressure (>=800 lines). This becomes a hard
# 1,000-line gate once the structural split campaign clears the baseline.
test-size:
    bun run test:size

# Run integration tests
test-integration:
    bun run test:integration

installed-live-test:
    bun run test:installed-live

# Portable behavior rung: real HRC instances and stores over fixture-only
# loopback transport. The runner mechanically selects the fixture-marked corpus
# and fails if no marked case actually starts.
test-federation-loopback:
    bun scripts/run-federation-corpus.ts loopback

# Live-interface qualification rung. Absence of a tailnet interface is failure;
# loopback mode is intentionally not in this command's environment.
test-federation-live:
    bun scripts/run-federation-corpus.ts live

# Run linter
lint:
    bun run lint

# Fix lint issues
lint-fix:
    bun run lint:fix

# Run type checker
typecheck:
    bun run typecheck

# Run repo-split boundary + manifest edge checks
check:
    bun scripts/check-dependency-pins.ts
    bun scripts/check-boundaries.ts
    bun scripts/check-manifest-edges.ts
    bun scripts/check-cli-surface.ts
    bun scripts/check-public-surface.ts
    bun scripts/check-suppressions.ts
    bun scripts/check-env-hygiene.ts

# Prune nested node_modules copies of a root-pinned dependency that shadow the
# root resolution. `bun install` writes but never tidies, so a copy an earlier
# resolution wrote survives every install after the manifest is corrected — and
# TypeScript keeps resolving to it. Pass --check to report without deleting.
doctor *args:
    bun scripts/workspace-doctor.ts {{args}}

# Validate durable architecture records and generated projections
architecture-records *args:
    bun scripts/check-architecture-records.ts {{args}}

# The declared landing gate. It depends on `env-up` by ruling (T-06900 +
# T-06902, joint): the gate provisions the environment it needs instead of
# inheriting it. Before that ruling a green `just verify` was partly a statement
# about the operator's live production daemon rather than about the tree under
# test — strictly worse than merely non-hermetic. `env-up` also owns the build,
# which `typecheck` has always required (it reads sibling dist/*.d.ts) and the
# gate never declared.

# Written as a script rather than a dependency list (`verify: env-up check …`)
# because just runs each dependency in its OWN shell: env-up would provision the
# environment and then none of the stages would see it. That shape looked right
# and failed the proof — the corpus ran against no daemon and no agents root.
# The eval is what actually connects the two.

# Run all verification (env-up + check + lint + typecheck + test)
verify: env-up
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(bash scripts/dev-env.sh env)"
    just architecture-records
    just check
    just lint
    just typecheck
    just test
    just test-federation-loopback

# -- Ephemeral development environment (T-06896) -----------------------------
#
# hrc-runtime is a daemon project, so "the environment the suite needs" is a
# running daemon and a resolvable agent home — not a database and a port. Both
# were satisfied ambiently until now (the operator's production daemon at
# ~/praesidium/var/run/hrc, the operator's homes at ~/praesidium/var/agents),
# which is why the suite was green on exactly one machine. `env-up` provisions
# both under one temp root and touches neither of the real ones. See
# scripts/dev-env.sh for the why in full.
#
# `env-up` leaves its daemon running on purpose — a second `env-up` reuses it,
# so back-to-back `just verify` / `just e2e` do not pay for a restart. Reap it
# with `just env-down` when you are done for the day.

# Provision the ephemeral e2e environment (idempotent, self-healing)
env-up:
    bash scripts/dev-env.sh up

# Tear the ephemeral e2e environment down (safe on a half-built or crashed root)
env-down:
    bash scripts/dev-env.sh down

# The e2e suite is the whole corpus run against a REAL provisioned daemon,
# because that is what this project's tests actually exercise: live unix
# sockets, live tmux panes, and the CLIs spawned as subprocesses. Running it any
# other way tests a mock of the thing rather than the thing.

# Run the e2e suite against the ephemeral environment
e2e: env-up
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(bash scripts/dev-env.sh env)"
    echo "[e2e] daemon ${HRC_RUNTIME_DIR}/hrc.sock, agents ${ASP_AGENTS_ROOT}"
    bun run test
    just test-federation-loopback

# Clean build artifacts
clean:
    bun run clean

# Rebuild from scratch
rebuild:
    bun run rebuild

# Install dependencies
# Dependency pulls are explicit via `just pull-deps`; install never advances bun.lock.
# Options are name=value tokens in any order: no-sync=1, force-sync=1, force-link=1,
# allow-dirty=1. `just` arguments are positional, so they are passed through opaquely
# and parsed by scripts/install-options.ts rather than bound to recipe parameters.
# Linked Git worktrees auto-disable the global wrapper cutover unless force-link=1 is passed explicitly.
# Linked worktrees publish HRC packages to the isolated worktree tag/channel.
# An install builds and publishes the tree on disk, so it refuses a worktree with
# tracked modifications (staged or unstaged; untracked files are ignored) before
# it builds anything. Pass allow-dirty=1 to install uncommitted work deliberately.
install *options:
    #!/usr/bin/env bash
    set -euo pipefail
    # Repo-owned hooks, not lefthook's generated template. Set here because a
    # fresh clone otherwise silently falls back to .git/hooks, whose final branch
    # is `pnpm lefthook` — which materialises a pnpm node_modules that shadows the
    # workspace. This is config, so it cannot be carried by a tracked file alone.
    git config core.hooksPath .githooks
    bun scripts/install-dirty-guard.ts --source-root="$PWD" {{ options }}
    policy="$(bun scripts/install-policy.ts shell {{ options }})"
    eval "$policy"
    echo "[install] context=${PRAESIDIUM_INSTALL_CONTEXT} sync=${PRAESIDIUM_INSTALL_SYNC_MODE} link=${PRAESIDIUM_INSTALL_LINK_MODE} publish=${PRAESIDIUM_INSTALL_PUBLISH_CHANNEL} tag=${PRAESIDIUM_INSTALL_PUBLISH_TAG}"
    echo "[install] dependency pulls are explicit; preserving bun.lock"
    # Warn, never refuse. The dev workspace makes the suite resolve agent-spaces
    # SOURCE while this install builds the locked tuple, so the two can disagree —
    # but a consumer lagging its producer is the intended steady state, and
    # refusing here would wedge every fleet install on every agent-spaces commit.
    bun scripts/check-asp-skew.ts --warn || true
    bun scripts/atomic-install.ts \
      --context="$PRAESIDIUM_INSTALL_CONTEXT" \
      --link-mode="$PRAESIDIUM_INSTALL_LINK_MODE" \
      --publish-channel="$PRAESIDIUM_INSTALL_PUBLISH_CHANNEL" \
      --source-root="$PWD"

# Install and activate the per-user Ghostty presentation sidecar. This recipe
# deliberately does not run as part of `just install`; viewer rollout is a
# separate, reversible GUI-user decision.
install-hrc-viewer-launchd:
    #!/usr/bin/env bash
    set -euo pipefail
    source_plist="$(git rev-parse --show-toplevel)/launchd/com.praesidium.hrc-viewer.plist"
    installed_plist="$HOME/Library/LaunchAgents/com.praesidium.hrc-viewer.plist"
    service_target="gui/$(id -u)/com.praesidium.hrc-viewer"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/praesidium/var/logs"
    escaped_home="$(printf '%s' "$HOME" | sed 's/[\/&]/\\&/g')"
    sed "s/__HOME__/$escaped_home/g" "$source_plist" > "$installed_plist.next"
    plutil -lint "$installed_plist.next"
    install -m 0644 "$installed_plist.next" "$installed_plist"
    rm "$installed_plist.next"
    if launchctl print "$service_target" >/dev/null 2>&1; then
      launchctl bootout "$service_target"
    fi
    launchctl bootstrap "gui/$(id -u)" "$installed_plist"
    launchctl print "$service_target" >/dev/null
    echo "[install] activated $service_target"

# Deploy to the co-hosted lab logical node (defaults to the latest pushed main)
deploy-lab ref="origin/main":
    @just _deploy-node "lab@mini" "lab" "{{ ref }}"

# Deploy to the max3 logical node (defaults to the latest pushed main)
deploy-max3 ref="origin/main":
    @just _deploy-node "max3" "max3" "{{ ref }}"

# The `@max3` default means the hrc source commit max3's daemon is RUNNING right
# now, not origin/main HEAD. Pass an explicit ref (a SHA, tag, or origin/main) to
# target something else.

# Deploy to the svc logical node (user lherron on mini)
deploy-svc ref="@max3":
    @just _deploy-node "mini" "svc" "{{ ref }}"

# `hrcdev` here is the Tart macOS guest VM hosted on max3 (`ssh hrcdev`), NOT the
# ~/praesidium/var/install/hrc-dev lane, which is a git-archive export with its
# own LaunchAgent and no release manifest. See AGENTS.md.

# Deploy to the hrcdev logical node (the Tart guest VM on max3)
deploy-hrcdev ref="@max3":
    @just _deploy-node "hrcdev" "hrcdev" "{{ ref }}"

# The commit is resolved ONCE and passed to both nodes as a literal SHA. Letting
# each node resolve `@max3` for itself would race a concurrent max3 install and
# could leave the two nodes on different commits while reporting success.

# Bring svc and hrcdev to the hrc source commit max3 is running
deploy-fleet-from-max3:
    #!/usr/bin/env bash
    set -euo pipefail
    target="$(just _max3-source-commit)"
    echo "[fleet] target hrc sourceCommit ${target} (running on max3)"
    just _deploy-node "mini" "svc" "$target"
    just _deploy-node "hrcdev" "hrcdev" "$target"

# Run this before and after a deploy; an unreachable node prints as unreachable
# instead of aborting the table.

# Read-only hrc/asp parity table across max3, svc, lab, and hrcdev
fleet-status:
    #!/usr/bin/env bash
    set -uo pipefail

    probe() {
      local label="$1" target="$2" status hrc asp health coherent
      if [[ -z "$target" ]]; then
        status="$(hrc server status --json 2>/dev/null)"
      else
        status="$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" \
          'export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hrc server status --json' \
          2>/dev/null)"
      fi
      if [[ -z "$status" ]]; then
        printf '%-8s %-12s %s\n' "$label" 'unreachable' '-'
        return
      fi
      health="$(jq -r '.status // "down"' <<<"$status")"
      hrc="$(jq -r '.release.hrcBuild.sourceCommit // "unknown"' <<<"$status")"
      asp="$(jq -r '.release.aspBuild.setVersion // "unknown"' <<<"$status")"
      coherent="$(jq -r '.release.runningEqualsInstalled // false' <<<"$status")"
      printf '%-8s %-12s %-10s %-28s %s\n' \
        "$label" "$health" "${hrc:0:8}" "$asp" \
        "$([[ "$coherent" == true ]] && echo 'running==installed' || echo 'STALE PROCESS')"
    }

    printf '%-8s %-12s %-10s %-28s %s\n' NODE STATUS HRC ASP COHERENCE
    probe max3 ''
    probe svc 'mini'
    probe lab 'lab@mini'
    probe hrcdev 'hrcdev'

# Print the hrc source commit max3's daemon is currently running.
#
# This is the authority behind the `@max3` target ref, and it fails closed rather
# than guessing: a daemon that is not running its own installed release has no
# single answer to "what version is max3 running", so `runningEqualsInstalled`
# is a hard gate, not a warning.
[private]
_max3-source-commit:
    #!/usr/bin/env bash
    set -euo pipefail
    fail() { printf '@max3: %s\n' "$*" >&2; exit 1; }

    status="$(hrc server status --json 2>/dev/null)" || fail 'local HRC daemon is not reachable'
    health="$(jq -r '.status // "down"' <<<"$status")"
    [[ "$health" == healthy ]] || fail "local HRC daemon is ${health}, not healthy"
    node="$(jq -r '.node.nodeId // ""' <<<"$status")"
    [[ "$node" == max3 ]] ||
      fail "the @max3 target ref must be resolved on max3; this node is ${node:-unknown}"
    [[ "$(jq -r '.release.runningEqualsInstalled // false' <<<"$status")" == true ]] ||
      fail 'max3 is not running its own installed release; install/restart max3 first'
    jq -er '.release.hrcBuild.sourceCommit' <<<"$status" ||
      fail 'max3 status did not report a release sourceCommit'

[private]
_deploy-node ssh-target expected-node target-ref="origin/main":
    #!/usr/bin/env bash
    set -euo pipefail

    target_ref='{{ target-ref }}'
    if [[ "$target_ref" == '@max3' ]]; then
      target_ref="$(just _max3-source-commit)"
    fi

    ssh -o BatchMode=yes -o ConnectTimeout=10 "{{ ssh-target }}" \
      bash -s -- "{{ expected-node }}" "$target_ref" <<'REMOTE'
    set -euo pipefail

    expected_node="$1"
    target_ref="$2"
    repo="$HOME/praesidium/hrc-runtime"

    # `ssh host cmd` gets a non-interactive, non-login shell, which reads only
    # ~/.zshenv. svc's does not add ~/.bun/bin or Homebrew, so `hrc` and `just`
    # are both MISSING over ssh there while they resolve fine on lab and hrcdev.
    # Prepend the canonical locations rather than requiring every node's dotfiles
    # to agree.
    export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

    fail() {
      printf 'deploy-%s: %s\n' "$expected_node" "$*" >&2
      exit 1
    }

    command -v git >/dev/null 2>&1 || fail 'git is not available'
    command -v hrc >/dev/null 2>&1 || fail 'hrc is not available'
    command -v jq >/dev/null 2>&1 || fail 'jq is not available'
    command -v just >/dev/null 2>&1 || fail 'just is not available'
    [[ -d "$repo/.git" ]] || fail "checkout not found at $repo"

    status_before="$(hrc server status --json)" || fail 'HRC daemon is not healthy'
    actual_node="$(jq -er '.node.nodeId' <<<"$status_before")" ||
      fail 'HRC status did not report a logical node ID'
    [[ "$actual_node" == "$expected_node" ]] ||
      fail "expected logical node $expected_node, found $actual_node"

    cd "$repo"
    branch="$(git branch --show-current)"
    [[ "$branch" == 'main' ]] || fail "checkout must be on main, found ${branch:-detached HEAD}"
    if [[ -n "$(git status --porcelain)" ]]; then
      git status --short >&2
      fail 'checkout is dirty; refusing to overwrite remote work'
    fi

    git fetch --prune origin main
    target_sha="$(git rev-parse --verify --quiet "${target_ref}^{commit}")" ||
      fail "cannot resolve target ref ${target_ref} in this checkout"

    # Containment. `just install` enforces this itself (publish-local-verdaccio's
    # canonical gate refuses a source commit origin/main does not contain), but
    # only AFTER the checkout has already moved. Checking it here keeps a refused
    # deploy from leaving the node parked on an unpublished commit.
    git merge-base --is-ancestor "$target_sha" origin/main ||
      fail "target ${target_sha} is not contained by freshly fetched origin/main"

    head_sha="$(git rev-parse HEAD)"
    running_sha="$(jq -r '.release.hrcBuild.sourceCommit // ""' <<<"$status_before")"
    running_installed="$(jq -r '.release.runningEqualsInstalled // false' <<<"$status_before")"
    if [[ "$head_sha" == "$target_sha" && "$running_sha" == "$target_sha" &&
          "$running_installed" == 'true' ]]; then
      printf '%s already at %s: checkout, installed release, and running daemon agree\n' \
        "$expected_node" "$target_sha"
      exit 0
    fi

    # Direction. --ff-only cannot move backwards, so a node at or ahead of the
    # target would take a silent no-op merge and then report a green deploy after
    # install+restart without ever having moved. Refuse instead; going backwards
    # is an operator decision, not something a deploy should do quietly.
    git merge-base --is-ancestor "$head_sha" "$target_sha" || {
      git log --oneline --decorate --left-right "$head_sha...$target_sha" >&2
      fail "checkout ${head_sha} is ahead of or diverged from target ${target_sha}"
    }

    git merge --ff-only "$target_sha"
    [[ "$(git rev-parse HEAD)" == "$target_sha" ]] ||
      fail 'checkout did not reach the target revision'

    busy_json="$(hrc runtime list --status busy --json)" ||
      fail 'could not inspect busy runtimes'
    busy_count="$(jq -er 'length' <<<"$busy_json")" ||
      fail 'busy runtime inventory was not a JSON array'
    if (( busy_count > 0 )); then
      jq . <<<"$busy_json" >&2
      fail "$busy_count runtime(s) are busy; drain them before deployment"
    fi

    just install no-sync=1
    # Lifecycle mutations refuse a partial HRC/ASP session envelope (T-06007
    # gate). A node's login profile may export convenience vars from that
    # envelope (svc exports ASP_DEFAULT_TASK=minisvc, lab exports minilab), which
    # would make this operator deploy shell look like a half-formed agent
    # session. Strip exactly the envelope keys for the lifecycle calls — the
    # gate's own prescribed remediation ("run from a clean operator shell").
    lifecycle_env=(env -u HRC_SESSION_REF -u HRC_RUN_ID -u HRC_BIRTH_CREDENTIAL
      -u ASP_SCOPE_REF -u ASP_TASK_ID -u ASP_DEFAULT_TASK -u ASP_HANDLE)
    # Restart onto the freshly-selected release. The correct mechanism differs by
    # supervisor: svc/max3 run gui LaunchAgents that `hrc server restart` detects and
    # kickstarts cleanly. hrcdev runs its daemon unsupervised with no plist at all,
    # where the same command finds no launchd owner and takes its stop +
    # self-daemonize + restart-proof path — also correct, no special case needed.
    # lab runs a system LaunchDaemon (no gui session for uid 502), which
    # `hrc server restart` does NOT detect — it would self-daemonize a second
    # process and race the KeepAlive respawn. For lab, stop and let launchd bring it
    # back on the new release (root-free: lab may signal its own-uid process).
    if [[ "$expected_node" == lab ]]; then
      "${lifecycle_env[@]}" hrc server stop || fail 'hrc server stop failed on lab'
      healthy=""
      for _ in $(seq 1 40); do
        sleep 3
        [[ "$(hrc server status --json 2>/dev/null | jq -r '.status // "down"')" == healthy ]] && { healthy=1; break; }
      done
      [[ -n "$healthy" ]] || fail 'lab daemon did not become healthy after stop+respawn'
    else
      "${lifecycle_env[@]}" hrc server restart --wait --wait-timeout-ms 300000
    fi

    # The daemon can lag its supervisor respawn by a few seconds; a single
    # unretried status probe here failed three deploys in a row on max3.
    status_after=""
    for _ in $(seq 1 20); do
      if status_after="$(hrc server status --json 2>/dev/null)" &&
        [[ "$(jq -r '.status // "down"' <<<"$status_after")" == healthy ]]; then
        break
      fi
      status_after=""
      sleep 3
    done
    [[ -n "$status_after" ]] || fail 'HRC daemon did not become healthy'
    actual_node="$(jq -er '.node.nodeId' <<<"$status_after")" ||
      fail 'post-restart status did not report a logical node ID'
    [[ "$actual_node" == "$expected_node" ]] ||
      fail "post-restart logical node changed to $actual_node"
    release_path="$(jq -er '.packagePath' <<<"$status_after")" ||
      fail 'post-restart status did not report packagePath'
    binary_path="$(jq -er '.binaryPath' <<<"$status_after")" ||
      fail 'post-restart status did not report binaryPath'
    release_root="${release_path%/packages/hrc-server}"
    [[ "$release_root" == "$HOME/.bun/install/hrc-runtime-releases/release-"* ]] ||
      fail "packagePath is not an atomic HRC release: $release_path"
    [[ "$binary_path" == "$release_root/"* ]] ||
      fail "binaryPath and packagePath name different releases: $binary_path vs $release_path"

    # Release IDENTITY, not just release shape. Everything above proves a healthy
    # daemon is running some atomic release; a restart onto a stale one looks
    # exactly this healthy. Only the sourceCommit says the node is running what
    # was asked for.
    deployed_sha="$(jq -er '.release.hrcBuild.sourceCommit' <<<"$status_after")" ||
      fail 'post-restart status did not report a release sourceCommit'
    [[ "$deployed_sha" == "$target_sha" ]] ||
      fail "daemon is running ${deployed_sha}, expected ${target_sha}"
    [[ "$(jq -r '.release.runningEqualsInstalled // false' <<<"$status_after")" == 'true' ]] ||
      fail 'running daemon is not the installed release'
    asp_version="$(jq -r '.release.aspBuild.setVersion // "unknown"' <<<"$status_after")"

    printf 'deployed %s to %s: %s (asp %s)\n' \
      "$target_sha" "$expected_node" "$release_root" "$asp_version"
    REMOTE

pull-deps:
    #!/usr/bin/env bash
    set -euo pipefail
    git diff --quiet -- bun.lock && git diff --cached --quiet -- bun.lock || { echo "pull-deps: bun.lock must be clean before pulling" >&2; exit 1; }
    bun scripts/sync-asp-from-verdaccio.ts --pull
    bun scripts/sync-wrkq-from-verdaccio.ts --pull
    bun scripts/commit-verdaccio-lock.ts
    # Residual skew AFTER the pull. A pull advances the lock to registry latest, so
    # anything still ahead is unpublished agent-spaces work — which this repo
    # cannot fix and which names the repo that can.
    bun scripts/report-residual-asp-skew.ts || true

check-deps:
    bun scripts/sync-asp-from-verdaccio.ts --check
    bun scripts/sync-wrkq-from-verdaccio.ts --check

# Publish timestamped dev package set to local Verdaccio
publish-dev:
    bun scripts/publish-local-verdaccio.ts

# Publish a canonical package set from the freshly fetched named source ref
publish-canonical:
    bun scripts/publish-local-verdaccio.ts --channel canonical

# Validate a canonical package set without publishing
publish-canonical-dry-run:
    bun scripts/publish-local-verdaccio.ts --channel canonical --dry-run

# Validate timestamped dev package set without publishing
publish-dev-dry-run:
    bun scripts/publish-local-verdaccio.ts --dry-run

# Publish isolated linked-worktree package set to local Verdaccio
publish-worktree:
    bun scripts/publish-local-verdaccio.ts --channel worktree

# Validate isolated linked-worktree package set without publishing
publish-worktree-dry-run:
    bun scripts/publish-local-verdaccio.ts --channel worktree --dry-run

# Publish exact semver package set to local Verdaccio
publish-semver version tag="latest" force="":
    bun scripts/publish-local-verdaccio.ts --version "{{version}}" --tag "{{tag}}" {{force}}

# Validate exact semver package set without publishing
publish-semver-dry-run version tag="latest":
    bun scripts/publish-local-verdaccio.ts --version "{{version}}" --tag "{{tag}}" --dry-run

# Serve the ACP Session Dashboard (acp-ops-web) against the local dev stack
serve-dashboard:
    cd packages/acp-ops-web && bun run dev

# Serve standalone HTML docs/specs locally and over tailnet
serve-docs port="18481" bind="0.0.0.0":
    python3 -m http.server {{port}} --bind {{bind}} -d docs/html

# Run control-plane interface test with rex-home target
cp-test prompt="List skills available. Use only what is in your context, no tools.":
    ASP_HOME=/Users/lherron/praesidium/var/spaces-repo bun scripts/cp-interface-test.ts \
        --target default \
        --target-dir /Users/lherron/praesidium/rex-home \
        --model claude/sonnet \
        "{{prompt}}"
