# hrc-pty

Per-seat pty supervisor and attach client for tmux-free Claude seats
(T-12046 spec §4; spike T-12047). Standalone: nothing in rusthrc uses it yet.

```
hrc-pty serve  --socket <ipcDir>/hrcpty.sock [--cols N --rows N] [--runtime-id ID]
               [--broker-stderr PATH] [--token-file PATH] [--answers PATH] [--log PATH]
               [--foreground] [--broker-argv ARG...]      # --broker-argv takes the rest
hrc-pty attach --socket PATH [--token-file PATH] [--read-only] [--byte-log PATH]
hrc-pty vt-capture --cols N --rows N [--scrollback N] FILE  # a byte log through libghostty-vt
hrc-pty version
```

`serve` double-forks, prints its pid and exits 0 once the socket (mode 0600) is
bound; startup errors come back on stderr with exit 1. The token defaults to
`<ipcDir>/attach.token`, the standalone log to `<ipcDir>/hrcpty.log` (0600).
HRC passes `--log` explicitly: `~/praesidium/var/logs/hrc-runtime/hrcpty/<runtime-id>.log`
for the default runtime root, or `<runtime-root>/logs/hrcpty/<runtime-id>.log`
for isolated daemons. The `hrcpty/` log directory is 0700. Startup prunes regular
`rt-*.log` files older than seven days unless a non-terminal runtime row still
claims the id; symlinks and legacy IPC logs are untouched.

## Broker and child lifecycle

The broker runs in its own process group (T-12162 §4.1). Whenever the broker
exits, for any reason, hrc-pty TERMs that group, KILLs it if a member is still
alive 5 s later, and only then emits `broker.exited`; the pty child is its own
session and keeps running. `shutdown` ends the same group the same way, whether
or not the broker is still alive. A `spawn` after a child has exited opens a
fresh pty and a fresh model, and sends RIS to clients still attached so they
drop the last child's screen and modes. An attach while no child exists gets
RIS; a read-only attach never spawns.

## Clients and the child env

The child's env carries `HRC_PTY_SOCKET=<ops socket>`, so a program in the
seat can reach its supervisor (the token is `<ipcDir>/attach.token`).
`hrc-pty attach` sends `remote: true` in its handshake when `SSH_CONNECTION`
is set in its own env. hrc-pty keeps a focused bit per read-write client from
the `CSI I`/`CSI O` focus reports on that client's data connection (true
until the first report). Those bytes still reach the child. A report split
across two reads is not recognised. `status.clients` counts `total`,
`readWrite`, `readOnly`, `remote` and `focused`.

## libghostty-vt

`GHOSTTY_COMMIT` pins the scriptable-ghostty commit. The default build links
the debug-stripped static lib in `vendor/<commit>/` (with the headers it was
built from), so no zig is needed anywhere. `build.rs` refuses a pin that
differs from Loggia's `vendor/GHOSTTY_COMMIT` and only warns when there is no
Loggia checkout to compare with. To move the pin: change `GHOSTTY_COMMIT`
with Loggia's, then `just hrc-pty-vendor-lib` (zig 0.17 on PATH or `ZIG=`).
`HRC_PTY_BUILD_VT=1` builds against a fresh source build instead of the
vendor dir. The bindings are hand-written (`src/vt.rs`); a unit test checks
every struct against the library's own ABI manifest.

## Responder answers

`responder-answers.json` is what a real Ghostty answered to Claude Code
2.1.312's startup queries, recorded through `hrc-pty attach` in a Ghostty
window (`just hrc-pty-record-answers`). It is compiled in; `--answers`
overrides it.

## e2e

`just e2e-hrc-pty` (also run by `just e2e`): Claude Code under a bare serve,
attach clients in real Ghostty windows through ghostmux. Needs a logged-in
`claude` and a running Ghostty; E3 submits 20 prompts and interrupts each.
The G legs (broker group, no-child attach, respawn) need neither; X spawns
the real Codex TUI under a read-write Ghostty client and sends no prompt.
`--only` picks legs.
