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
    @echo "  just install-dev - Local install: build the working tree and cut the CLI over (no push)"
    @echo "  just install   - Release install; refuses an unpushed, dirty, or uncontained tree"
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
    bun scripts/check-lock-coherence.ts
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
# tracked modifications to SOURCE (staged or unstaged; untracked files are ignored)
# before it builds anything. Documentation -- docs/, architecture/, and any
# .md/.markdown/.html/.htm/.txt file -- cannot change what an install builds, so it
# never gates one; scripts/lib/install-source-scope.ts owns that cut and fails
# closed. Pass allow-dirty=1 to install uncommitted source deliberately.
install *options:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "[install] RELEASE path: requires a clean tree pushed to and contained by origin/main."
    echo "[install] For a LOCAL install use \`just install-dev\` -- same build and cutover, no push."
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
    # Refuse, never warn: a split ASP set in bun.lock is not lag, it is a release
    # that would ship two agent-spaces tuples at once (hand-run `bun update`).
    bun scripts/check-lock-coherence.ts
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
      # bootout returns before the job is actually gone; a bootstrap that races
      # it fails with "Bootstrap failed: 5: Input/output error" and leaves the
      # viewer DOWN with this recipe exiting non-zero (T-07711). Wait it out.
      for _ in $(seq 1 50); do
        launchctl print "$service_target" >/dev/null 2>&1 || break
        sleep 0.2
      done
    fi
    bootstrapped=0
    for attempt in 1 2 3 4 5; do
      if launchctl bootstrap "gui/$(id -u)" "$installed_plist"; then
        bootstrapped=1
        break
      fi
      echo "[install] bootstrap attempt $attempt failed; retrying" >&2
      sleep 1
    done
    [[ "$bootstrapped" == 1 ]] || { echo "[install] could not bootstrap $service_target after 5 attempts" >&2; exit 1; }
    launchctl print "$service_target" >/dev/null
    echo "[install] activated $service_target"

# A node runs three processes this lane deploys, in dependency order:
#   aspd          ASP preparation service (agent-spaces checkout -> immutable
#                 release under ~/praesidium/var/aspd, launchd com.praesidium.aspd)
#   hrc-server    this repo (atomic release, launchd com.praesidium.hrc-server)
#   mail injector hrc-mail-injector, bunx-pinned from Verdaccio (launchd
#                 com.praesidium.hrc-mail-injector)
# Each takes its own target. `@max3` means what max3 is RUNNING right now;
# `origin/main` / `latest` mean the newest pushed or published build.

# Deploy to the max3 logical node (defaults to the latest pushed main and latest injector)
deploy-max3 ref="origin/main" aspd="origin/main" injector="latest" restart="wait":
    @just _deploy-node "max3" "max3" "{{ ref }}" "{{ aspd }}" "{{ injector }}" "{{ restart }}"

# Deploy to the svc logical node (user lherron on mini)
deploy-svc ref="@max3" aspd="@max3" injector="@max3" restart="wait":
    @just _deploy-node "mini" "svc" "{{ ref }}" "{{ aspd }}" "{{ injector }}" "{{ restart }}"

# `hrcdev` here is the Tart macOS guest VM hosted on max3 (`ssh hrcdev`), NOT the
# ~/praesidium/var/install/hrc-dev lane, which is a git-archive export with its
# own LaunchAgent and no release manifest. See AGENTS.md.

# Deploy to the hrcdev logical node (the Tart guest VM on max3)
deploy-hrcdev ref="@max3" aspd="@max3" injector="@max3" restart="wait":
    @just _deploy-node "hrcdev" "hrcdev" "{{ ref }}" "{{ aspd }}" "{{ injector }}" "{{ restart }}"

# The targets are resolved ONCE and passed to every node as literals. Letting
# each node resolve `@max3` for itself would race a concurrent max3 install and
# could leave nodes on different builds while reporting success.

# Bring svc and hrcdev to the hrc, aspd and mail-injector builds max3 is running
deploy-fleet restart="wait":
    #!/usr/bin/env bash
    set -euo pipefail
    hrc_sha="$(just _max3-source-commit)"
    aspd_sha="$(just _max3-aspd-commit)"
    injector="$(just _max3-injector-version)"
    echo "[fleet] targets from max3: hrc ${hrc_sha} aspd ${aspd_sha} injector ${injector}"
    just _deploy-node "mini" "svc" "$hrc_sha" "$aspd_sha" "$injector" "{{ restart }}"
    just _deploy-node "hrcdev" "hrcdev" "$hrc_sha" "$aspd_sha" "$injector" "{{ restart }}"
    just fleet-status

# Run this before and after a deploy; an unreachable node prints as unreachable
# instead of aborting the table.

# Read-only hrc/aspd/injector parity table plus bun/codex/claude tool versions across max3, svc, and hrcdev
fleet-status:
    #!/usr/bin/env bash
    set -uo pipefail

    # One login-free probe per node: HRC status (which carries HRC's own live
    # aspd probe) plus the injector job as launchd sees it. An injector that is
    # running but not owned by its launchd job is exactly the state that dies
    # silently on the next reboot, so it prints as UNSUPERVISED, not as a version.
    node_probe='export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
      status="$(hrc server status --json 2>/dev/null | jq -c .)"
      [[ -n "$status" ]] || status="{}"
      printf "%s\n" "$status"
      socket="$(jq -r ".socketPath // empty" <<<"$status" 2>/dev/null)"
      job="$(launchctl print "gui/$(id -u)/com.praesidium.hrc-mail-injector" 2>/dev/null)"
      pid="$(awk '\''$1 == "pid" && $2 == "=" { print $3; exit }'\'' <<<"$job")"
      if [[ -n "$pid" ]]; then
        ps -o command= -p "$pid" | grep -oE "hrc-mail-injector@[^ /]+" | head -1 | sed "s/^hrc-mail-injector@//"
      else
        loose=""
        for p in $(pgrep -u "$(id -u)" -f hrc-mail-injector); do
          ps eww -p "$p" -o command= | tr " " "\n" | grep -qx "HRC_SOCKET_PATH=$socket" && loose=1
        done
        [[ -n "$loose" ]] && echo UNSUPERVISED || echo down
      fi'

    probe() {
      local label="$1" target="$2" out status health hrc aspd injector coherent
      if [[ -z "$target" ]]; then
        out="$(bash -c "$node_probe" 2>/dev/null)"
      else
        out="$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" "bash -c $(printf '%q' "$node_probe")" 2>/dev/null)"
      fi
      status="$(sed -n '1p' <<<"$out")"
      if [[ -z "$status" || "$status" == '{}' ]]; then
        printf '%-8s %-12s %s\n' "$label" 'unreachable' '-'
        return
      fi
      injector="$(sed -n '2p' <<<"$out")"
      health="$(jq -r '.status // "down"' <<<"$status")"
      hrc="$(jq -r '.release.hrcBuild.sourceCommit // "unknown"' <<<"$status")"
      aspd="$(jq -r 'if .api.aspd.reachable == true then (.api.aspd.release.sourceCommit // "unidentified")[0:8] else "DOWN" end' <<<"$status")"
      coherent="$(jq -r '.release.runningEqualsInstalled // false' <<<"$status")"
      printf '%-8s %-12s %-10s %-10s %-26s %s\n' \
        "$label" "$health" "${hrc:0:8}" "$aspd" "${injector:-unknown}" \
        "$([[ "$coherent" == true ]] && echo 'running==installed' || echo 'STALE PROCESS')"
    }

    printf '%-8s %-12s %-10s %-10s %-26s %s\n' NODE STATUS HRC ASPD INJECTOR COHERENCE
    probe max3 ''
    probe svc 'mini'
    probe hrcdev 'hrcdev'

    # Harness tool versions. Read through a LOGIN shell so PATH matches what the
    # node's agents get (mini's codex lives under nvm, invisible to a bare ssh
    # PATH). The daemon does not pin these: a node-local `bun upgrade` changed
    # node:net semantics under every hook bridge on svc (2026-09-07) and a codex
    # downgrade broke thread/resume the same day, both while hrc/asp parity read
    # clean. max3 is the reference; a value that differs from max3 is marked `*`.
    tool_probe='zsh -lic "bun --version 2>/dev/null | head -1; codex --version 2>/dev/null | head -1; claude --version 2>/dev/null | head -1" 2>/dev/null'
    tools() {
      local label="$1" target="$2" out
      if [[ -z "$target" ]]; then
        out="$(bash -c "$tool_probe")"
      else
        out="$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" "$tool_probe" 2>/dev/null)"
      fi
      if [[ -z "$out" ]]; then
        printf '%-8s %s\n' "$label" 'unreachable'
        return
      fi
      # Normalise "codex-cli 0.153.4" and "2.1.263 (Claude Code)" to bare versions.
      local bun codex claude
      bun="$(sed -n '1p' <<<"$out")"
      codex="$(sed -n '2p' <<<"$out" | sed -E 's/^codex-cli +//')"
      claude="$(sed -n '3p' <<<"$out" | sed -E 's/ +\(Claude Code\)$//')"
      if [[ "$label" == max3 ]]; then
        ref_bun="$bun"; ref_codex="$codex"; ref_claude="$claude"
      fi
      mark() { [[ -n "$1" && "$1" == "$2" ]] && printf '%s' "$1" || printf '%s*' "${1:-missing}"; }
      printf '%-8s %-10s %-10s %s\n' "$label" \
        "$(mark "$bun" "$ref_bun")" "$(mark "$codex" "$ref_codex")" "$(mark "$claude" "$ref_claude")"
    }

    ref_bun=''; ref_codex=''; ref_claude=''
    printf '\n%-8s %-10s %-10s %s\n' NODE BUN CODEX CLAUDE
    tools max3 ''
    tools svc 'mini'
    tools hrcdev 'hrcdev'

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

# Print the agent-spaces source commit max3's aspd is serving, as HRC's own
# live probe reports it. An unreachable or unidentified aspd has no answer.
[private]
_max3-aspd-commit:
    #!/usr/bin/env bash
    set -euo pipefail
    fail() { printf '@max3 aspd: %s\n' "$*" >&2; exit 1; }

    status="$(hrc server status --json 2>/dev/null)" || fail 'local HRC daemon is not reachable'
    [[ "$(jq -r '.node.nodeId // ""' <<<"$status")" == max3 ]] ||
      fail 'the @max3 aspd target must be resolved on max3'
    [[ "$(jq -r '.api.aspd.reachable // false' <<<"$status")" == true ]] ||
      fail "max3 aspd is not reachable: $(jq -c '.api.aspd.error // {}' <<<"$status")"
    jq -er '.api.aspd.release.sourceCommit' <<<"$status" ||
      fail 'max3 aspd did not report a release sourceCommit'

# Print the hrc-mail-injector version max3's supervised injector is running. The
# running argv is the authority, not the plist: a plist rewritten without a
# reload names a version nobody runs.
[private]
_max3-injector-version:
    #!/usr/bin/env bash
    set -euo pipefail
    fail() { printf '@max3 injector: %s\n' "$*" >&2; exit 1; }

    [[ "$(hrc server status --json 2>/dev/null | jq -r '.node.nodeId // ""')" == max3 ]] ||
      fail 'the @max3 injector target must be resolved on max3'
    job="$(launchctl print "gui/$(id -u)/com.praesidium.hrc-mail-injector" 2>/dev/null)" ||
      fail 'launchd job com.praesidium.hrc-mail-injector is not loaded on max3; run just install-mail-injector-launchd <version> first'
    pid="$(awk '$1 == "pid" && $2 == "=" { print $3; exit }' <<<"$job")"
    [[ -n "$pid" ]] || fail 'max3 injector job is loaded but not running'
    version="$(ps -o command= -p "$pid" | grep -oE 'hrc-mail-injector@[^ /]+' | head -1 | sed 's/^hrc-mail-injector@//')"
    [[ -n "$version" ]] || fail "could not read a pinned version from injector pid ${pid}"
    printf '%s\n' "$version"

# Install and (re)load the supervised hrc-mail-injector on THIS node, pinned to an
# exact version (or `latest`, resolved to one here and pinned). Replaces any
# earlier injector serving this node's HRC socket, supervised or not: two
# injectors against one HRC are two mail writers. Requires the injector state
# store to already carry its one-time kicker-store import marker; a fresh node
# needs that import before it can be supervised this way.
#
# Install/reload this node's launchd-supervised hrc-mail-injector at a pinned version
install-mail-injector-launchd version:
    #!/usr/bin/env bash
    set -euo pipefail
    fail() { printf 'install-mail-injector: %s\n' "$*" >&2; exit 1; }
    export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

    version='{{ version }}'
    if [[ "$version" == latest ]]; then
      version="$(npm view hrc-mail-injector@latest version 2>/dev/null)" ||
        fail 'could not resolve hrc-mail-injector@latest from the configured registry'
    fi
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] ||
      fail "pin an exact version, got '${version}'"

    label=com.praesidium.hrc-mail-injector
    uid="$(id -u)"
    service_target="gui/${uid}/${label}"
    source_plist="$(git rev-parse --show-toplevel)/launchd/${label}.plist"
    installed_plist="$HOME/Library/LaunchAgents/${label}.plist"
    hrc_plist="$HOME/Library/LaunchAgents/com.praesidium.hrc-server.plist"
    state_path="$HOME/praesidium/var/state/acp/hrc-mail-injector.sqlite"
    log_path="$HOME/praesidium/var/logs/hrc-mail-injector.log"

    status="$(hrc server status --json 2>/dev/null)" || fail 'HRC daemon is not reachable'
    node_id="$(jq -er '.node.nodeId' <<<"$status")" || fail 'HRC status did not report a node ID'
    socket_path="$(jq -er '.socketPath' <<<"$status")" || fail 'HRC status did not report its socket path'
    bunx_path="$(command -v bunx)" || fail 'bunx is not on PATH'
    # The injector talks to the same canonical wrkq the node's HRC does; take it
    # from HRC's supervisor env rather than restating it per node.
    hrc_env="$(plutil -extract EnvironmentVariables json -o - "$hrc_plist")" ||
      fail "cannot read EnvironmentVariables from ${hrc_plist}"
    wrkq_db="$(jq -er '.HRC_WRKQ_DB' <<<"$hrc_env")" || fail "${hrc_plist} declares no HRC_WRKQ_DB"
    token_file="$(jq -er '.HRC_WRKQD_TOKEN_FILE' <<<"$hrc_env")" ||
      fail "${hrc_plist} declares no HRC_WRKQD_TOKEN_FILE"
    [[ -f "$state_path" ]] || fail "injector state store ${state_path} does not exist"
    imports="$(sqlite3 -readonly "$state_path" 'SELECT count(*) FROM injector_store_imports' 2>/dev/null)" ||
      fail "${state_path} has no injector_store_imports table"
    (( imports > 0 )) || fail "${state_path} carries no kicker-store import marker"

    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/praesidium/var/logs"
    esc() { printf '%s' "$1" | sed 's/[\/&|]/\\&/g'; }
    sed -e "s|__HOME__|$(esc "$HOME")|g" \
        -e "s|__NODE_ID__|$(esc "$node_id")|g" \
        -e "s|__SOCKET_PATH__|$(esc "$socket_path")|g" \
        -e "s|__WRKQ_DB__|$(esc "$wrkq_db")|g" \
        -e "s|__WRKQD_TOKEN_FILE__|$(esc "$token_file")|g" \
        -e "s|__BUNX__|$(esc "$bunx_path")|g" \
        -e "s|__VERSION__|$(esc "$version")|g" \
        "$source_plist" > "$installed_plist.next"
    plutil -lint "$installed_plist.next" >/dev/null
    ! grep -q '__[A-Z_]*__' "$installed_plist.next" || fail 'unrendered placeholder in plist'

    # Current already: the loaded job runs exactly this rendered plist and pinned
    # version, and nothing else serves this socket. Reloading anyway would drop
    # in-flight mail work for no change.
    running_pid="$(launchctl print "$service_target" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }' || true)"
    if [[ -n "$running_pid" ]] && cmp -s "$installed_plist.next" "$installed_plist" &&
       ps -o command= -p "$running_pid" | grep -q "hrc-mail-injector@${version}"; then
      others=0
      for pid in $(pgrep -u "$uid" -f 'hrc-mail-injector' || true); do
        [[ "$pid" == "$running_pid" ]] && continue
        ps eww -p "$pid" -o command= 2>/dev/null | tr ' ' '\n' | grep -qx "HRC_SOCKET_PATH=${socket_path}" && others=1
      done
      if (( others == 0 )); then
        rm "$installed_plist.next"
        echo "[injector] already current: ${service_target} pid ${running_pid} running hrc-mail-injector@${version}"
        exit 0
      fi
    fi

    # Retire every earlier injector for this node before the new one loads:
    # our own job, ad-hoc `launchctl submit` jobs (com.praesidium.hrc-mail-injector.<suffix>),
    # then any loose process whose environment names this node's HRC socket.
    # Injectors pointed at other sockets (isolated test namespaces) are left alone.
    while read -r old; do
      [[ -n "$old" ]] || continue
      echo "[injector] bootout gui/${uid}/${old}"
      launchctl bootout "gui/${uid}/${old}" 2>/dev/null || true
    done < <(launchctl list | awk '{ print $3 }' | grep -E "^${label//./\\.}(\..+)?$" || true)
    for _ in $(seq 1 50); do
      launchctl print "$service_target" >/dev/null 2>&1 || break
      sleep 0.2
    done
    for pid in $(pgrep -u "$uid" -f 'hrc-mail-injector' || true); do
      if ps eww -p "$pid" -o command= 2>/dev/null | tr ' ' '\n' | grep -qx "HRC_SOCKET_PATH=${socket_path}"; then
        echo "[injector] stopping unsupervised injector pid ${pid}"
        kill -TERM "$pid" 2>/dev/null || true
      fi
    done
    for _ in $(seq 1 50); do
      stray=0
      for pid in $(pgrep -u "$uid" -f 'hrc-mail-injector' || true); do
        ps eww -p "$pid" -o command= 2>/dev/null | tr ' ' '\n' | grep -qx "HRC_SOCKET_PATH=${socket_path}" && stray=1
      done
      (( stray == 0 )) && break
      sleep 0.2
    done
    (( stray == 0 )) || fail 'an earlier injector for this node would not exit'

    install -m 0644 "$installed_plist.next" "$installed_plist"
    rm "$installed_plist.next"
    log_offset="$(stat -f %z "$log_path" 2>/dev/null || echo 0)"
    launchctl bootstrap "gui/${uid}" "$installed_plist" || fail "could not bootstrap ${service_target}"

    # Prove the outcome: the job's pid runs the pinned version, the injector
    # reported itself running, and the same pid is still alive 10s later (a
    # KeepAlive crash loop changes the pid and fails here).
    pid=""
    for _ in $(seq 1 60); do
      pid="$(launchctl print "$service_target" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }' || true)"
      if [[ -n "$pid" ]] && tail -c +"$((log_offset + 1))" "$log_path" 2>/dev/null | grep -q '"status":"running"'; then
        break
      fi
      pid=""
      sleep 1
    done
    [[ -n "$pid" ]] || fail "injector did not report running; see ${log_path} and ${log_path%.log}.err.log"
    ps -o command= -p "$pid" | grep -q "hrc-mail-injector@${version}" ||
      fail "injector pid ${pid} is not running hrc-mail-injector@${version}"
    sleep 10
    [[ "$(launchctl print "$service_target" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }')" == "$pid" ]] ||
      fail "injector pid ${pid} did not survive 10s; it is crash-looping"
    echo "[injector] ${service_target} pid ${pid} running hrc-mail-injector@${version} for node ${node_id}"

[private]
_deploy-node ssh-target expected-node target-ref="origin/main" aspd-ref="origin/main" injector="latest" restart="wait":
    #!/usr/bin/env bash
    set -euo pipefail

    target_ref='{{ target-ref }}'
    if [[ "$target_ref" == '@max3' ]]; then
      target_ref="$(just _max3-source-commit)"
    fi
    aspd_ref='{{ aspd-ref }}'
    if [[ "$aspd_ref" == '@max3' ]]; then
      aspd_ref="$(just _max3-aspd-commit)"
    fi
    injector='{{ injector }}'
    if [[ "$injector" == '@max3' ]]; then
      injector="$(just _max3-injector-version)"
    elif [[ "$injector" == latest ]]; then
      injector="$(npm view hrc-mail-injector@latest version)"
    fi

    ssh -o BatchMode=yes -o ConnectTimeout=10 "{{ ssh-target }}" \
      bash -s -- "{{ expected-node }}" "$target_ref" "$aspd_ref" "$injector" "{{ restart }}" <<'REMOTE'
    set -euo pipefail

    expected_node="$1"
    target_ref="$2"
    aspd_ref="$3"
    injector_version="$4"
    restart_mode="$5"
    repo="$HOME/praesidium/hrc-runtime"
    asp_repo="$HOME/praesidium/agent-spaces"
    aspd_ns="$HOME/praesidium/var/aspd"
    aspd_label=com.praesidium.aspd

    # `ssh host cmd` gets a non-interactive, non-login shell, which reads only
    # ~/.zshenv. svc's does not add ~/.bun/bin or Homebrew, so `hrc` and `just`
    # are both MISSING over ssh there while they resolve fine on hrcdev.
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
    command -v bun >/dev/null 2>&1 || fail 'bun is not available'
    [[ -d "$repo/.git" ]] || fail "checkout not found at $repo"
    [[ -d "$asp_repo/.git" ]] || fail "agent-spaces checkout not found at $asp_repo"
    [[ -f "$aspd_ns/service/config.json" ]] ||
      fail "aspd namespace not initialised at $aspd_ns (agent-spaces: just aspd-init $aspd_ns)"

    status_before="$(hrc server status --json)" || fail 'HRC daemon is not healthy'
    actual_node="$(jq -er '.node.nodeId' <<<"$status_before")" ||
      fail 'HRC status did not report a logical node ID'
    [[ "$actual_node" == "$expected_node" ]] ||
      fail "expected logical node $expected_node, found $actual_node"

    # Resolve and gate BOTH checkouts before anything moves: a refusal on the
    # second must not leave the first half-deployed.
    #   containment — the target is contained by freshly fetched origin/main
    #     (`just install` enforces this itself, but only after the checkout moved)
    #   direction   — the checkout is at or behind the target; --ff-only cannot
    #     move backwards, so a node ahead of it would no-op and report green
    checkout_to() {
      local dir="$1" ref="$2" what="$3" branch sha head
      cd "$dir"
      branch="$(git branch --show-current)"
      [[ "$branch" == 'main' ]] || fail "$what checkout must be on main, found ${branch:-detached HEAD}"
      if [[ -n "$(git status --porcelain)" ]]; then
        git status --short >&2
        fail "$what checkout is dirty; refusing to overwrite remote work"
      fi
      git fetch --quiet --prune origin main
      sha="$(git rev-parse --verify --quiet "${ref}^{commit}")" ||
        fail "cannot resolve $what target ref ${ref} in this checkout"
      git merge-base --is-ancestor "$sha" origin/main ||
        fail "$what target ${sha} is not contained by freshly fetched origin/main"
      head="$(git rev-parse HEAD)"
      git merge-base --is-ancestor "$head" "$sha" || {
        git log --oneline --decorate --left-right "$head...$sha" >&2
        fail "$what checkout ${head} is ahead of or diverged from target ${sha}"
      }
      printf '%s\n' "$sha"
    }
    target_sha="$(checkout_to "$repo" "$target_ref" hrc)"
    aspd_sha="$(checkout_to "$asp_repo" "$aspd_ref" agent-spaces)"
    echo "[deploy-${expected_node}] targets: hrc ${target_sha} aspd ${aspd_sha} injector ${injector_version}"

    running_sha="$(jq -r '.release.hrcBuild.sourceCommit // ""' <<<"$status_before")"
    running_installed="$(jq -r '.release.runningEqualsInstalled // false' <<<"$status_before")"
    hrc_current=0
    if [[ "$(git -C "$repo" rev-parse HEAD)" == "$target_sha" && "$running_sha" == "$target_sha" &&
          "$running_installed" == 'true' ]]; then
      hrc_current=1
    fi

    # Busy runtimes do not block a deploy: brokers reattach across an HRC
    # restart. `wait` drains in-flight runs first (bounded); `force` restarts
    # through them, which is the only mode that works from a live agent turn on
    # the node being deployed (its own turn never drains).
    case "$restart_mode" in
      wait) restart_flags=(--wait --wait-timeout-ms 300000) ;;
      force) restart_flags=(--force) ;;
      *) fail "restart mode must be wait or force, got ${restart_mode}" ;;
    esac

    # ---- 1. aspd ------------------------------------------------------------
    # HRC refuses every birth without a reachable aspd, so it goes first and is
    # proven through HRC's own live probe, not through aspd's pid file (a stale
    # pid file and socket are exactly what a dead unsupervised aspd leaves).
    aspd_probe() { hrc server status --json 2>/dev/null | jq -c '.api.aspd // {}'; }
    aspd_supervisor="$(jq -r '.supervisor.label // ""' "$aspd_ns/service/config.json")"
    aspd_now="$(aspd_probe)"
    if [[ "$(jq -r '.reachable // false' <<<"$aspd_now")" == true &&
          "$(jq -r '.release.sourceCommit // ""' <<<"$aspd_now")" == "$aspd_sha" &&
          "$aspd_supervisor" == "$aspd_label" ]]; then
      echo "[aspd] already serving ${aspd_sha} under ${aspd_label}"
    else
      cd "$asp_repo"
      git merge --ff-only --quiet "$aspd_sha"
      [[ "$(git rev-parse HEAD)" == "$aspd_sha" ]] || fail 'agent-spaces checkout did not reach the aspd target'
      bun install --frozen-lockfile >/dev/null
      # The build prints progress before its final JSON inspection; keep only the
      # last top-level object.
      build_out="$(just build-asp-release)" || fail 'build-asp-release failed'
      build_json="$(awk '/^\{$/ { buf = "" } { buf = buf $0 "\n" } END { printf "%s", buf }' <<<"$build_out")"
      release_id="$(jq -er '.releaseId' <<<"$build_json")" || fail 'build-asp-release reported no releaseId'
      artifact="$(jq -er '.releasePath' <<<"$build_json")" || fail 'build-asp-release reported no releasePath'
      [[ "$(jq -r '.sourceCommit' <<<"$build_json")" == "$aspd_sha" ]] ||
        fail "built release ${release_id} is not from ${aspd_sha}"
      if [[ ! -d "$aspd_ns/releases/$release_id" ]]; then
        just install-asp-release "$artifact" "$aspd_ns/releases" >/dev/null
      fi
      if [[ -z "$aspd_supervisor" ]]; then
        # Hand the service lifetime to launchd before activation; an unsupervised
        # aspd that dies stays dead and the node silently stops birthing.
        bun scripts/aspd-service.ts supervise "$aspd_ns" "$aspd_label" >/dev/null
      elif [[ "$aspd_supervisor" != "$aspd_label" ]]; then
        fail "aspd namespace is supervised by ${aspd_supervisor}, expected ${aspd_label}"
      fi
      just aspd-activate "$aspd_ns" "$release_id" >/dev/null
    fi
    aspd_now=""
    for _ in $(seq 1 20); do
      aspd_now="$(aspd_probe)"
      [[ "$(jq -r '.reachable // false' <<<"$aspd_now")" == true &&
         "$(jq -r '.release.sourceCommit // ""' <<<"$aspd_now")" == "$aspd_sha" ]] && break
      aspd_now=""
      sleep 3
    done
    [[ -n "$aspd_now" ]] || fail "HRC does not see aspd serving ${aspd_sha}: $(aspd_probe)"
    aspd_job_pid="$(launchctl print "gui/$(id -u)/${aspd_label}" 2>/dev/null |
      awk '$1 == "pid" && $2 == "=" { print $3; exit }' || true)"
    [[ -n "$aspd_job_pid" ]] || fail "aspd is serving but launchd job ${aspd_label} owns no running pid"
    aspd_release="$(jq -r '.release.releaseId' <<<"$aspd_now")"
    echo "[aspd] ${aspd_label} pid ${aspd_job_pid} serving ${aspd_release} (${aspd_sha})"

    # ---- 2. hrc-server ------------------------------------------------------
    cd "$repo"
    lifecycle_env=(env -u HRC_SESSION_REF -u HRC_RUN_ID -u HRC_BIRTH_CREDENTIAL
      -u ASP_SCOPE_REF -u ASP_TASK_ID -u ASP_DEFAULT_TASK -u ASP_HANDLE)
    if (( hrc_current == 1 )); then
      echo "[hrc] already at ${target_sha}: checkout, installed release, and running daemon agree"
    else
      git merge --ff-only --quiet "$target_sha"
      [[ "$(git rev-parse HEAD)" == "$target_sha" ]] ||
        fail 'checkout did not reach the target revision'

      # Publish containment (T-07959). hrcdev is a disposable Tart guest that
      # reaches BOTH its own Verdaccio and the shared fleet registry, so its
      # publishes must stay on loopback; the publish boundary refuses a non-loopback
      # target from that node and there is no override flag. The guest plist declares
      # this same value, but plist env stops at the broker and never reaches an agent
      # shell — which is why the lane names it here instead of inheriting it.
      install_env=(env)
      if [[ "$expected_node" == hrcdev ]]; then
        install_env=(env VERDACCIO_REGISTRY=http://127.0.0.1:4873/)
      fi
      "${install_env[@]}" just install no-sync=1
      # Lifecycle mutations refuse a partial HRC/ASP session envelope (T-06007
      # gate). A node's login profile may export convenience vars from that
      # envelope (svc exports ASP_DEFAULT_TASK=minisvc), which would make this
      # operator deploy shell look like a half-formed agent session. Strip exactly
      # the envelope keys for the lifecycle calls — the gate's own prescribed
      # remediation ("run from a clean operator shell").
      #
      # Every node runs a gui LaunchAgent that `hrc server restart` detects and
      # kickstarts. hrcdev has been launchd-managed since 2026-08-18; a comment
      # that once claimed it ran unsupervised is what let T-07957 pass as a green
      # deploy over a self-daemonized daemon carrying none of the plist's
      # environment. The CLI now refuses that path; the assertion below proves the
      # outcome on the node instead of trusting the mechanism.
      "${lifecycle_env[@]}" hrc server restart "${restart_flags[@]}" \
        --reason "deploy ${expected_node} to ${target_sha}"
    fi

    # The daemon can lag its supervisor respawn by a few seconds; a single
    # unretried status probe here failed three deploys in a row on max3.
    #
    # The wait must satisfy EVERY field this block goes on to read, not just
    # `.status` (T-07957). Breaking the instant health flips captures ONE
    # snapshot that every later read is taken from, and `.pid` lags health: a
    # deploy-svc run aborted with "post-restart status did not report a daemon
    # pid" while svc was healthy under launchd the whole time. Retrying around
    # the `jq` would not help — it would re-parse the same stale bytes forever.
    # `.pidAlive` is required too, because a lagging `.pid` is not always
    # missing: it can still name the PRE-restart process, which is present
    # enough to pass a null check and then fail the launchctl ownership match
    # below as a confusing "unsupervised" verdict.
    status_after=""
    for _ in $(seq 1 20); do
      if status_after="$(hrc server status --json 2>/dev/null)" &&
        [[ "$(jq -r '.status // "down"' <<<"$status_after")" == healthy ]] &&
        [[ "$(jq -r '.pid // "none"' <<<"$status_after")" != none ]] &&
        [[ "$(jq -r '.pidAlive // false' <<<"$status_after")" == true ]]; then
        break
      fi
      status_after=""
      sleep 3
    done
    [[ -n "$status_after" ]] || fail 'HRC daemon did not become healthy with a live pid'
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
    [[ "$(jq -r '.api.aspd.release.sourceCommit // ""' <<<"$status_after")" == "$aspd_sha" ]] ||
      fail "restarted daemon does not see aspd ${aspd_sha}: $(jq -c '.api.aspd' <<<"$status_after")"

    # Supervisor identity, not just health. Everything above proves a healthy
    # daemon running the requested release — and a detached daemon that
    # self-daemonized past an unloaded LaunchAgent proves exactly that too, while
    # carrying none of the environment the plist declares. That daemon has no
    # canonical wrkq endpoint and no aspd socket, so cold summonses to the node are
    # never seated and nothing local says why (T-07957). Assert the process, not
    # the mechanism.
    supervisor_target="gui/$(id -u)/com.praesidium.hrc-server"
    supervisor_plist="$HOME/Library/LaunchAgents/com.praesidium.hrc-server.plist"
    [[ -f "$supervisor_plist" ]] || fail "no hrc-server LaunchAgent declared at ${supervisor_plist}"
    server_pid="$(jq -er '.pid' <<<"$status_after")" ||
      fail 'post-restart status did not report a daemon pid'
    job_pid="$(launchctl print "$supervisor_target" 2>/dev/null |
      awk '$1 == "pid" && $2 == "=" { print $3; exit }' || true)"
    if [[ "$job_pid" != "$server_pid" ]]; then
      launchctl print "$supervisor_target" 2>/dev/null |
        awk '$1 == "state" || $1 == "pid" || $1 == "runs" { print "  " $0 }' >&2
      fail "${supervisor_target} does not own the daemon serving this node (pid ${server_pid}); it is unsupervised, or a second supervisor holds the socket. Repair: hrc server stop, then bootstrap the node's own job"
    fi
    # Ownership is not the environment. `ps eww` prints the process environment
    # as inherited, which is the only place the plist's keys are observable on
    # the running daemon.
    daemon_env="$(ps eww -p "$server_pid" -o command= | tr ' ' '\n')" ||
      fail "could not read the environment of daemon pid ${server_pid}"
    while read -r key; do
      [[ -n "$key" ]] || continue
      grep -q "^${key}=" <<<"$daemon_env" ||
        fail "daemon pid ${server_pid} is missing ${key}, which ${supervisor_plist} declares; it is not running with its supervisor's environment"
    done < <(plutil -extract EnvironmentVariables json -o - "$supervisor_plist" 2>/dev/null |
      jq -r 'keys[] | select(startswith("HRC_"))')
    echo "[hrc] ${supervisor_target} owns pid ${server_pid} running ${deployed_sha} with the plist environment"

    # ---- 3. mail injector ---------------------------------------------------
    # After HRC: the injector subscribes to the daemon's streams and must come up
    # against the restarted one. The recipe comes from the checkout just moved to
    # the target, so the node runs the injector lane its own release ships.
    just install-mail-injector-launchd "$injector_version"

    printf 'deployed %s: hrc %s (%s), aspd %s (%s), injector %s\n' \
      "$expected_node" "$target_sha" "$release_root" "$aspd_sha" "$aspd_release" "$injector_version"
    REMOTE

pull-deps:
    #!/usr/bin/env bash
    set -euo pipefail
    git diff --quiet -- bun.lock && git diff --cached --quiet -- bun.lock || { echo "pull-deps: bun.lock must be clean before pulling" >&2; exit 1; }
    bun scripts/sync-asp-from-verdaccio.ts --pull
    bun scripts/sync-wrkq-from-verdaccio.ts --pull
    bun scripts/check-lock-coherence.ts
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

# Local dev install: build the working tree as it stands and cut the local CLI
# over to it. `just install` is still the release path — it proves the source is
# committed and contained by a freshly fetched origin/main before it publishes.
# This recipe deliberately skips that proof, so it needs no push and tolerates a
# dirty tree; it publishes on the `worktree` tag, leaving the `latest` dev
# channel other repos pull untouched. Run `hrc server restart` afterwards to move
# the daemon onto it.
install-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    bun scripts/atomic-install.ts \
      --context=main \
      --link-mode=on \
      --publish-channel=worktree \
      --source-root="$PWD"
