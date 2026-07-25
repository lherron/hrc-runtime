# Atomic HRC CLI installs

`just install` prepares a complete HRC runtime image away from the checkout and
cuts the installed `hrc`, `hrcchat`, and `hrcmail` commands over only after dependency
installation, build, entrypoint smoke checks, and package publication succeed.

## Installed layout

The active commands use one stable indirection:

```text
~/.bun/bin/hrc, hrcchat, hrcmail
  -> ~/.bun/install/global/node_modules/{hrc-cli,hrcchat-cli,hrcmail-cli}
  -> ~/.bun/install/hrc-runtime-current/packages/{hrc-cli,hrcchat-cli,hrcmail-cli}
  -> ~/.bun/install/hrc-runtime-releases/release-*/
```

Each release directory contains its own source snapshot, workspace packages,
build outputs, `node_modules`, and `praesidium-release.json`. That manifest
records the release ID, the exact canonical HRC package build, the exact
canonical ASP package build selected by the lock/install, and the installation
time. Cutover is refused unless both coherent build tuples validate. The
checkout's `node_modules` is not removed or rewritten by a main-checkout
install. The final rename of `hrc-runtime-current` changes all three commands
together.

Main-checkout atomic installs are canonical publications. Before copying source,
the installer freshly fetches `HRC_CANONICAL_REF` (default `origin/main`),
requires a clean checkout, proves `HEAD` is contained by that ref, and archives
that exact commit. Canonical packages carry the seven-field `praesidiumBuild`
tuple, cannot replace an existing name/version, and are read back through
cache-empty registry tarball requests. Linked-worktree publication remains
explicitly non-canonical.

On the first atomic install, the installer converts legacy Bun links that point
directly into the checkout. It first points `hrc-runtime-current` at the same
currently installed root, changes the stable package links to use that
indirection, and only then prepares and selects the new release. A failure at
any point before the final rename leaves the previous command surface usable.

## Concurrency contract

All HRC installs on the machine serialize through:

```text
~/.bun/install/hrc-runtime-install.lock/
```

A second install fails immediately with an `install already in progress`
diagnostic that includes the owner PID, source root, and start time. It never
mutates the release under preparation or the active links. This guarantee also
covers linked-worktree installs, even though their default policy leaves global
wrappers unchanged.

If an installer is killed hard, confirm no `scripts/atomic-install.ts` process
with the recorded PID is running before removing that exact lock directory and
retrying. A stale lock blocks installation but does not affect the selected
release.

## Failure and rollback behavior

- Dependency, build, smoke, or publication failure deletes only the incomplete
  uniquely named release and leaves `hrc-runtime-current` unchanged.
- `hrc --help`, `hrcchat --help`, and `hrcmail --help` run from the prepared image before cutover.
- Successfully installed release directories are retained, so rollback is an
  atomic repoint of `~/.bun/install/hrc-runtime-current` to a known-good prior
  release.
- A daemon restart is still required after `just install` when server code has
  changed; the running process does not reload merely because the CLI link moved.

## Observable release identity

An atomic daemon reads its colocated `praesidium-release.json` once at startup
and fails closed if the manifest is missing or malformed. `hrc server status`
reports that captured HRC/ASP identity and recomputes
`runningEqualsInstalled` on every read:

- `true` means the running daemon came from the release currently selected by
  `hrc-runtime-current`.
- `false` means a newer release was installed after this process started (or
  the installed link cannot be resolved).
- A daemon started directly from a source checkout reports `mode: unmanaged`
  explicitly and never claims equality with an atomic installed release.

The deterministic concurrency harness is
`scripts/atomic-install-live-harness.test.ts`. It repeatedly invokes the stable
installed CLI while a new release intentionally has no dependencies yet, then
checks failed-preparation and concurrent-installer behavior. The release A/B
status and restart contract is covered by
`packages/hrc-server/src/__tests__/t06958-release-provenance.test.ts`.
