## Build & Run

This is a Bun monorepo with packages in `packages/*`.

```bash
bun install       # Install dependencies
bun run build     # Build all packages
```

## Validation

Run these after implementing to get immediate feedback:

- Only run tests (`bun run test`) **after modifying files under `packages/*` AND after manually testing if possible**.
- Tests: `bun run test`
- Typecheck: `bun run typecheck` (run `bun run build` first if workspace typings are missing)
- Lint: `bun run lint` (fix with `bun run lint:fix`)

## Ops Dashboard

When the user refers to the "ops dashboard", they mean the ACP ops web dashboard in `packages/acp-ops-web`.
Always open the ops dashboard in the Codex in-app browser when asked to start, inspect, or verify it.

Run it from `packages/acp-ops-web`:

```bash
bun run dev -- --host 127.0.0.1
```

Then open `http://127.0.0.1:5173/` in the in-app browser. If port `5173` is already serving the dashboard, reuse it instead of starting another server.

Operational notes from dashboard work:

- The real snapshot endpoint is `/v1/ops/session-dashboard/snapshot`.
- A successful real snapshot can contain sessions with `events: 0`; an empty event stream/timeline is not automatically a rendering bug.
- Dev demo data should only appear when the dashboard snapshot request fails in development, not before a successful real snapshot replaces it.
- For package-scoped validation after ops dashboard changes, prefer `bun run --filter acp-ops-web typecheck` and `bun run --filter acp-ops-web test`.

## Project Structure

```
packages/
├── agent-scope/      # ScopeRef/ScopeHandle/SessionRef/SessionHandle utilities
├── config/           # spaces-config: config-time determinism, resolution, locks, materialization
├── runtime/          # spaces-runtime: harness-agnostic runtime/session contracts
├── execution/        # spaces-execution: run-time orchestration and harness dispatch
├── harness-claude/   # Claude CLI + Agent SDK adapters
├── harness-codex/    # Codex adapter
├── harness-pi/       # Pi CLI adapter
├── harness-pi-sdk/   # Pi SDK adapter
├── agent-spaces/     # Public host-facing client surface
└── cli/              # CLI entry point
```

## Smoke Testing the CLI

**Always test `asp run` changes with `--dry-run`** to verify the generated Claude command without actually launching Claude.
**If you update something available via CLI, run the CLI to validate it.**

Run CLI commands with `--dry-run` to verify behavior without launching Claude:

```bash
# Run CLI directly with bun (no build step needed)
bun packages/cli/bin/asp.js <command>

# Set ASP_HOME to a writable path (avoids EPERM creating temp dirs)
ASP_HOME=/tmp/asp-test

# Test with a local space (dev mode)
ASP_HOME=/tmp/asp-test bun packages/cli/bin/asp.js run \
  integration-tests/fixtures/sample-registry/spaces/base --dry-run

# For codex harness dry-runs without a local Codex install
PATH=integration-tests/fixtures/codex-shim:$PATH \
  ASP_HOME=/tmp/asp-test bun packages/cli/bin/asp.js run \
  integration-tests/fixtures/sample-registry/spaces/base --dry-run --harness codex

# Test inherit flags
bun packages/cli/bin/asp.js run <space-path> --dry-run --inherit-all
bun packages/cli/bin/asp.js run <space-path> --dry-run --inherit-project --inherit-user

# Test settings composition (add [settings] to a space.toml first)
bun packages/cli/bin/asp.js run <space-path> --dry-run  # should show --settings flag
```

Note: `asp run` does not accept a `--prompt` flag.

Test fixtures are in `integration-tests/fixtures/`:
- `sample-registry/spaces/` - Various test spaces (base, frontend, backend, etc.)
- `sample-project/` - Project with asp-targets.toml
- `claude-shim/` - Mock claude binary for tests

## Codebase Patterns

- TypeScript with strict mode and `exactOptionalPropertyTypes`
- Optional properties use `prop?: T | undefined` pattern
- Biome for linting/formatting
- JSON schemas in `packages/config/src/core/schemas/`
- Error classes in `packages/config/src/core/errors.ts`

## Error Handling

`asp run` should **never** silently capture errors. It should always exit immediately when an error occurs.

- Do not use try/catch blocks that swallow errors
- Let filesystem errors propagate naturally
- Throw explicit errors for invalid states (e.g., missing bundle)
- Errors should be visible to the user, not hidden

## Pi Harness

When running with `--harness pi`:

- Always set `PI_CODING_AGENT_DIR=<asp_modules target pi dir>` as an environment variable
- This env var must appear in `--print-command` output for copy-paste compatibility
- This env var must be set when spawning the Pi process directly
- Add `--no-extensions` when there are no extensions to load (prevents Pi from loading defaults)
- Always add `--no-skills` to disable default skill loading from `.claude`, `.codex`, `~/.pi/agent/skills/`
- Materialize hooks to `hooks-scripts/` (Pi has an incompatible `hooks/` directory format)
