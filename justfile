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
        packages/hrc-server/src/__tests__/t06698-dm-peer-forward-routing.test.ts

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
# Linked Git worktrees auto-disable wrapper linking unless force-link=1 is passed explicitly.
# Linked worktrees publish HRC packages to the isolated worktree tag/channel.
install no-sync="" force-sync="" force-link="":
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(bun scripts/install-policy.ts shell --no-sync="{{ no-sync }}" --force-sync="{{ force-sync }}" --force-link="{{ force-link }}")"
    echo "[install] context=${PRAESIDIUM_INSTALL_CONTEXT} sync=${PRAESIDIUM_INSTALL_SYNC_MODE} link=${PRAESIDIUM_INSTALL_LINK_MODE} publish=${PRAESIDIUM_INSTALL_PUBLISH_CHANNEL} tag=${PRAESIDIUM_INSTALL_PUBLISH_TAG}"
    bun run clean
    rm -rf node_modules packages/*/node_modules
    echo "[install] dependency pulls are explicit; preserving bun.lock"
    bun install --frozen-lockfile
    bun run build
    if [ "$PRAESIDIUM_INSTALL_PUBLISH_CHANNEL" = "worktree" ]; then
      just publish-worktree
    else
      just publish-dev
    fi
    if [ "$PRAESIDIUM_INSTALL_LINK_MODE" != "off" ]; then
      if [ "$PRAESIDIUM_INSTALL_LINK_MODE" = "forced" ]; then
        echo "[install] WARNING: force-link enabled from ${PRAESIDIUM_INSTALL_CONTEXT}; updating local HRC wrappers"
      fi
      ( cd packages/hrc-cli && bun link )
      ( cd packages/hrcchat-cli && bun link )
    else
      echo "[install] skipping bun link; linked worktree installs must not update local HRC wrappers"
    fi

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
