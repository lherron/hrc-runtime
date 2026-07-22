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
    @echo "  just verify    - Run lint + typecheck + test"
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

# Federation landing/release gate: never permit a green run with the live
# tailnet corpus silently skipped.
test-federation-live:
    HRC_REQUIRE_LIVE_TAILNET_TESTS=1 bun test \
        packages/hrc-server/src/__tests__/t06607-registry-startup.test.ts \
        packages/hrc-server/src/__tests__/t06617-peer-protocol-e2e.test.ts \
        packages/hrc-server/src/__tests__/t06618-federation-accept-e2e.test.ts \
        packages/hrc-server/src/__tests__/t06619-federation-outbox-e2e.test.ts \
        packages/hrc-server/src/__tests__/t06620-federation-dm-wait-e2e.test.ts \
        packages/hrc-server/src/__tests__/t06621-binding-cache-routing-e2e.test.ts \
        packages/hrc-server/src/__tests__/t06663-registry-client.test.ts \
        packages/hrc-server/src/__tests__/t06668-local-registry-consult.test.ts \
        packages/hrc-server/src/__tests__/t06698-dm-peer-forward-routing.test.ts \
        packages/hrc-server/src/__tests__/t06698-registry-endpoint-split.test.ts

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

# Run all verification (check + lint + typecheck + test)
verify: check lint typecheck test

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
    hrc server restart --wait --wait-timeout-ms 300000

    status_after="$(hrc server status --json)" || fail 'HRC daemon did not become healthy'
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
