# Atomic HRC CLI installs

`just install` prepares a complete HRC runtime image away from the checkout and
cuts the installed `hrc` and `hrcchat` commands over only after dependency
installation, build, entrypoint smoke checks, and package publication succeed.

## Installed layout

The active commands use one stable indirection:

```text
~/.bun/bin/hrc, hrcchat
  -> ~/.bun/install/global/node_modules/{hrc-cli,hrcchat-cli}
  -> ~/.bun/install/hrc-runtime-current/packages/{hrc-cli,hrcchat-cli}
  -> ~/.bun/install/hrc-runtime-releases/release-*/
```

Each release directory contains its own source snapshot, workspace packages,
build outputs, and `node_modules`. The checkout's `node_modules` is not removed
or rewritten by a main-checkout install. The final rename of
`hrc-runtime-current` changes both commands together.

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
- `hrc --help` and `hrcchat --help` run from the prepared image before cutover.
- Successfully installed release directories are retained, so rollback is an
  atomic repoint of `~/.bun/install/hrc-runtime-current` to a known-good prior
  release.
- A daemon restart is still required after `just install` when server code has
  changed; the running process does not reload merely because the CLI link moved.

The deterministic concurrency harness is
`scripts/atomic-install-live-harness.test.ts`. It repeatedly invokes the stable
installed CLI while a new release intentionally has no dependencies yet, then
checks failed-preparation and concurrent-installer behavior.
