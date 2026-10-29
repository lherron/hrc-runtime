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
`<ipcDir>/attach.token`, the log to `<ipcDir>/hrcpty.log`.

## libghostty-vt

`GHOSTTY_COMMIT` pins the scriptable-ghostty commit. `build.rs` refuses to
build when it differs from Loggia's `vendor/GHOSTTY_COMMIT`, and on first use
builds the static lib with zig 0.17 (`scripts/build-libghostty-vt.sh`, about a
minute) into `crates/target/libghostty-vt/<commit>/`. `just hrc-pty-lib` does
the same by hand. The bindings are hand-written (`src/vt.rs`); a unit test
checks every struct against the library's own ABI manifest.

## Responder answers

`responder-answers.json` is what a real Ghostty answered to Claude Code
2.1.312's startup queries, recorded through `hrc-pty attach` in a Ghostty
window (`just hrc-pty-record-answers`). It is compiled in; `--answers`
overrides it.

## e2e

`just e2e-hrc-pty` (also run by `just e2e`): Claude Code under a bare serve,
attach clients in real Ghostty windows through ghostmux. Needs a logged-in
`claude` and a running Ghostty; E3 submits 20 prompts and interrupts each.
