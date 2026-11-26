# HRC runtime

The Harness Runtime Controller owns agent runtime lifecycle, broker event
ingest, and session and run state. The native `rusthrc` daemon and `hrc`
operator CLI live in the Cargo workspace under `crates/`. TypeScript client
packages live under `packages/`.

Agents use `prae seat` and `prae runtime` for ordinary observation and
coordination. Operators use `hrc` for daemon health, terminal attachment and
maintenance.

Start with the [documentation catalog](docs/README.md). The
[development workflow](docs/development-workflow.md) describes validation
and dependency boundaries. The [operations runbook](docs/operations-runbook.md)
covers release readback and live services.
