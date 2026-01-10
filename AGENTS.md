## Build & Run

This is a Bun monorepo with packages in `packages/*`.

```bash
bun install       # Install dependencies
bun run build     # Build all packages
```

## Validation

Run these after implementing to get immediate feedback:

- Tests: `bun run test`
- Typecheck: `bun run typecheck`
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

## Codebase Patterns

- TypeScript with strict mode and `exactOptionalPropertyTypes`
- Optional properties use `prop?: T | undefined` pattern
- Biome for linting/formatting
- JSON schemas in `packages/core/src/schemas/`
- Error classes in `packages/core/src/errors.ts`
