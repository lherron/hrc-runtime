# HRC Rust workspace

`hrc-common` is the shared leaf crate being introduced by the campaign's
`crate-graph-hrc-common` task. It owns shared federation configuration,
scope-reference parsing, and JavaScript compatibility helpers. It may depend on
external libraries, but no HRC crate.

`hrc-store` owns SQLite access, persisted row shapes, event append, and the small
store grammars (including terminal statuses and process identity). The sibling
`store-owns-*` tasks consolidate those definitions here. It may depend on
`hrc-common` and external libraries, never the CLI, daemon, domain, or kernel.
Its build script derives schema admission from the Bun migration graph; it does
not execute those migrations.

`hrc-domain` implements the HRC document and operations consumed by cardo. It
reads the owner API and opens the store for native reads. It may depend on
`hrc-store`, `hrc-common`, cardo, and external libraries; it must not depend on
the CLI, native daemon, or kernel.

`hrc-kernel` hosts the rebuildable HRC projection over cardo and exposes its
Unix socket for Loggia. It may depend on `hrc-domain`, shared leaf utilities,
cardo, and external libraries, never the CLI or native daemon.

`hrc-cli` implements the command surface. It may depend on `hrc-store`,
`hrc-common`, and external libraries, never the native daemon, domain, or kernel.

`hrc-native` owns the native daemon library and the `rusthrc` executable. The
library may depend on `hrc-store`, `hrc-common`, and external libraries. The
`rusthrc` binary composes the native library and `hrc-cli`; the library must not
import the CLI. The sibling `crate-graph-hrc-common` task establishes this split.

Allowed workspace edges:

- `hrc-common ← hrc-store ← {hrc-domain, hrc-cli, hrc-native lib}`
- `hrc-domain ← hrc-kernel`
- `rusthrc bin ← {hrc-native lib, hrc-cli}`

Here `A ← B` means B may depend on A. Shared leaf dependencies may also be
used directly where needed. External libraries are centrally declared in
`Cargo.toml`; member manifests inherit dependencies and the workspace lints.

Run `just cargo-check` from the repository root. It checks formatting, runs
Clippy with `-D warnings`, runs workspace tests, builds the kernel and native
binary, and drives the CLI differential, native foundation, and kernel socket
E2E scripts against those binaries. Scripts create isolated scratch roots;
these checks do not install or restart shared services. Set
`HRC_CLI_E2E_ARTIFACTS`, `HRC_NATIVE_E2E_ARTIFACTS`, and
`HRC_KERNEL_E2E_ARTIFACTS` to retain their reports at chosen paths.

The sibling `tests-and-e2e-triage` task owns the promoted E2E set and its
[script map](hrc-native/e2e/README.md). Consult that map for which additional
scripts run in the routine gate and which require a separate operational run.
