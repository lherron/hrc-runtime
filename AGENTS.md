## Build & Run

This is a Bun monorepo with packages in `packages/*`.

```bash
bun install       # Install dependencies
bun run build     # Build all packages
```

## Validation

Run these after implementing to get immediate feedback:

- Always run tests (`bun run test`) without asking.
- Tests: `bun run test`
- Typecheck: `bun run typecheck` (run `bun run build` first if workspace typings are missing)
- Lint: `bun run lint` (fix with `bun run lint:fix`)

## Project Structure

```
packages/
├── core/         # Types, schemas, config parsing, errors, locks, atomic writes
├── git/          # Git operations (shell-out wrapper)
├── claude/       # Claude CLI wrapper
├── resolver/     # Resolution engine
├── store/        # Content-addressed storage
├── materializer/ # Plugin directory generation
├── engine/       # Orchestration layer
├── lint/         # Linting rules
└── cli/          # CLI entry point
```

## Smoke Testing the CLI

**Always test `asp run` changes with `--dry-run`** to verify the generated Claude command without actually launching Claude.

Run CLI commands with `--dry-run` to verify behavior without launching Claude:

```bash
# Run CLI directly with bun (no build step needed)
bun packages/cli/bin/asp.js <command>

# Test with a local space (dev mode)
ASP_HOME=/tmp/asp-test bun packages/cli/bin/asp.js run \
  integration-tests/fixtures/sample-registry/spaces/base --dry-run

# Test inherit flags
bun packages/cli/bin/asp.js run <space-path> --dry-run --inherit-all
bun packages/cli/bin/asp.js run <space-path> --dry-run --inherit-project --inherit-user

# Test settings composition (add [settings] to a space.toml first)
bun packages/cli/bin/asp.js run <space-path> --dry-run  # should show --settings flag
```

Test fixtures are in `integration-tests/fixtures/`:
- `sample-registry/spaces/` - Various test spaces (base, frontend, backend, etc.)
- `sample-project/` - Project with asp-targets.toml
- `claude-shim/` - Mock claude binary for tests

## Codebase Patterns

- TypeScript with strict mode and `exactOptionalPropertyTypes`
- Optional properties use `prop?: T | undefined` pattern
- Biome for linting/formatting
- JSON schemas in `packages/core/src/schemas/`
- Error classes in `packages/core/src/errors.ts`

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
