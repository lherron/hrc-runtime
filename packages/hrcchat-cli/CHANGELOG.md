# hrcchat-cli — Changelog

## 0.1.0 — 2026-04-27

Migrated from a bespoke hand-rolled argv parser (`cli-args.ts`) to
**Commander v14** as part of the Commander CLI Upgrade project.

### Changed

- **Parser:** replaced `cli-args.ts` (134 LOC) with Commander v14 command
  tree in `src/main.ts`. All 12 verbs (`dm`, `who`, `summon`, `send`,
  `messages`, `watch`, `wait`, `peek`, `status`, `doctor`, `info`, `show`),
  flags, and positional arguments are unchanged.
- **Help output:** `hrcchat --help` and per-command help is now auto-generated
  by Commander. Formatting differs; content is equivalent.
- **Exit codes:** usage errors now consistently exit **2** via `CliUsageError`;
  runtime/server errors exit **1**.
- **Dependencies:** added `commander ^14.0.0` and workspace `cli-kit`.

### Added

- `src/print.ts` — shared output helper extracted during migration.

### Removed

- `src/cli-args.ts` — bespoke parser deleted (134 LOC including
  `extractPositionals`, `consumeBody`, `parseDuration`, etc.).

### Notes

- **No JSON output shape changes.** All structured output is bit-identical.
