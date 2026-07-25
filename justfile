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

# Run integration tests
test-integration:
    bun run test:integration

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
    bun scripts/check-boundaries.ts
    bun scripts/check-manifest-edges.ts
    bun scripts/check-cli-surface.ts
    bun scripts/check-public-surface.ts
    bun scripts/check-suppressions.ts
    bun scripts/check-env-hygiene.ts

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
# Linked Git worktrees auto-disable the global wrapper cutover unless force-link=1 is passed explicitly.
# Linked worktrees publish HRC packages to the isolated worktree tag/channel.
install no-sync="" force-sync="" force-link="":
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(bun scripts/install-policy.ts shell --no-sync="{{ no-sync }}" --force-sync="{{ force-sync }}" --force-link="{{ force-link }}")"
    echo "[install] context=${PRAESIDIUM_INSTALL_CONTEXT} sync=${PRAESIDIUM_INSTALL_SYNC_MODE} link=${PRAESIDIUM_INSTALL_LINK_MODE} publish=${PRAESIDIUM_INSTALL_PUBLISH_CHANNEL} tag=${PRAESIDIUM_INSTALL_PUBLISH_TAG}"
    echo "[install] dependency pulls are explicit; preserving bun.lock"
    bun scripts/atomic-install.ts \
      --context="$PRAESIDIUM_INSTALL_CONTEXT" \
      --link-mode="$PRAESIDIUM_INSTALL_LINK_MODE" \
      --publish-channel="$PRAESIDIUM_INSTALL_PUBLISH_CHANNEL" \
      --source-root="$PWD"

# Deploy the latest pushed main revision to the co-hosted lab logical node.
deploy-lab:
    @just _deploy-node "lab@mini" "lab"

# Deploy the latest pushed main revision to the max3 logical node.
deploy-max3:
    @just _deploy-node "max3" "max3"

[private]
_deploy-node ssh-target expected-node:
    #!/usr/bin/env bash
    set -euo pipefail

    ssh -o BatchMode=yes -o ConnectTimeout=10 "{{ ssh-target }}" \
      bash -s -- "{{ expected-node }}" <<'REMOTE'
    set -euo pipefail

    expected_node="$1"
    repo="$HOME/praesidium/hrc-runtime"

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
    local_sha="$(git rev-parse HEAD)"
    remote_sha="$(git rev-parse origin/main)"
    if [[ "$local_sha" != "$remote_sha" ]]; then
      merge_base="$(git merge-base HEAD origin/main)"
      if [[ "$merge_base" != "$local_sha" ]]; then
        git log --oneline --decorate --left-right HEAD...origin/main >&2
        fail 'main diverges from origin/main; refusing to reset local commits'
      fi
      git merge --ff-only origin/main
    fi
    [[ "$(git rev-parse HEAD)" == "$remote_sha" ]] ||
      fail 'checkout did not reach the fetched origin/main revision'

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
    # envelope (lab exports ASP_DEFAULT_TASK), which would make this operator
    # deploy shell look like a half-formed agent session. Strip exactly the
    # envelope keys for the lifecycle calls — the gate's own prescribed
    # remediation ("run from a clean operator shell").
    lifecycle_env=(env -u HRC_SESSION_REF -u HRC_RUN_ID -u HRC_BIRTH_CREDENTIAL
      -u ASP_SCOPE_REF -u ASP_TASK_ID -u ASP_DEFAULT_TASK -u ASP_HANDLE)
    # Restart onto the freshly-selected release. The correct mechanism differs by
    # supervisor: svc/max3 run gui LaunchAgents that `hrc server restart` detects and
    # kickstarts cleanly. lab runs a system LaunchDaemon (no gui session for uid 502),
    # which `hrc server restart` does NOT detect — it would self-daemonize a second
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

    printf 'deployed %s to %s: %s\n' "$remote_sha" "$expected_node" "$release_root"
    REMOTE

pull-deps:
    #!/usr/bin/env bash
    set -euo pipefail
    git diff --quiet -- bun.lock && git diff --cached --quiet -- bun.lock || { echo "pull-deps: bun.lock must be clean before pulling" >&2; exit 1; }
    PRAESIDIUM_SYNC_NO_COMMIT=1 bun scripts/sync-asp-from-verdaccio.ts --pull
    PRAESIDIUM_SYNC_NO_COMMIT=1 bun scripts/sync-wrkq-from-verdaccio.ts --pull
    bun scripts/commit-verdaccio-lock.ts

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
