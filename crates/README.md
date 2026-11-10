# HRC Rust workspace

`hrc-common` is the shared leaf crate being introduced by the campaign's
`crate-graph-hrc-common` task. It owns shared federation configuration,
scope-reference parsing, and JavaScript compatibility helpers. It may depend on
external libraries, but no HRC crate.

`hrc-store` owns SQLite access, persisted row shapes, event append, and the small
store grammars (including terminal statuses and process identity). The sibling
`store-owns-*` tasks consolidate those definitions here. It may depend on
`hrc-common` and external libraries, never the CLI, daemon, domain, or kernel.
It owns schema migration (`src/migrate/`, T-12840): only the daemon at boot and
`rusthrc store migrate` migrate; every other open admits or refuses.

`hrc-domain` declares HRC's six operator operations and uses an injected
in-process owner binding. Its only HRC dependency is `hrc-common`; external
dependencies are `cardo-runtime`, `serde` and `serde_json`. It must not depend
on the store, CLI or native daemon.

2026-11-02 amendment (praesidium-kernel r1.9, T-12360): rusthrc retains
an ops-only `hrc` provider at `<runtimeRoot>/hrc-kernel.sock` for operator
summon, restart, send and annotation put/act/delete. The provider has no
document, observation node types, ingest, read projector or seat attacher.
The separate Praesidium kernel owns the `praesidium:praesidium` document's
`seat`, `runtime` and `seat.ext` reads and seat attachment. Cardo requires an
executor of record for operations; HRC registers a stateless worker that
refuses all calls, while HrcAdapter dispatches the six owner operations before
core. The historical standalone kernel crate retired in T-12141 (§8.1);
T-12360 retires the later embedded read projection.

`hrc-cli` implements the command surface. It may depend on `hrc-store`,
`hrc-common`, and external libraries, never the native daemon, domain, or kernel.

`hrc-native` owns the native daemon library and the `rusthrc` executable. The
library may depend on `hrc-store`, `hrc-common`, `hrc-domain`, cardo, and external
libraries. The
`rusthrc` binary composes the native library and `hrc-cli`; the library must not
import the CLI. The sibling `crate-graph-hrc-common` task establishes this split.

Allowed workspace edges:

- `hrc-common ← {hrc-store, hrc-domain, hrc-cli, hrc-native lib}`
- `hrc-store ← {hrc-cli, hrc-native lib}`
- `hrc-domain ← hrc-native lib`
- `rusthrc bin ← {hrc-native lib, hrc-cli}`

Here `A ← B` means B may depend on A. Shared leaf dependencies may also be
used directly where needed. External libraries are centrally declared in
`Cargo.toml`; member manifests inherit dependencies and the workspace lints.

Run `just cargo-check` from the repository root. It checks formatting, runs
Clippy with `-D warnings`, runs workspace tests, builds rusthrc and hrc-pty, and
drives the CLI differential, native foundation, and kernel socket
E2E scripts against those binaries. Scripts create isolated scratch roots;
these checks do not install or restart shared services. Set
`HRC_CLI_E2E_ARTIFACTS` and `HRC_NATIVE_E2E_ARTIFACTS` to retain their reports at
chosen paths.

The sibling `tests-and-e2e-triage` task owns the promoted E2E set and its
[script map](hrc-native/e2e/README.md). Consult that map for which additional
scripts run in the routine gate and which require a separate operational run.
