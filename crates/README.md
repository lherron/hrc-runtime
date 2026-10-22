# HRC stage-1 kernel

`hrc-domain` reads the pinned HRC HTTP API. `hrc-kernel` embeds cardo at
1796e1c and serves the `hrc` rebuildable, ingest-only document. Neither crate
opens HRC's store or imports `packages/`. Stage 1b adds `seat.summon` over the existing declaration and start routes.

Build and validate from the repository root:

```sh
just cargo-check
just verify
```

The cargo leg includes a black-box Unix-socket E2E. Its fixture tests API
outages, sparse/spilled replay, incarnation replacement, stable seat identity,
attach descriptors and the pinned read set. It is separate from the real
installed gates in the migration proposal §4.8. Set
`HRC_KERNEL_E2E_ARTIFACTS=/path/out` to retain its report at a chosen path.

Atomic HRC installs ship `bin/hrc-kernel` beside the TS packages. The stable
max3 executable is `~/.bun/install/hrc-runtime-current/bin/hrc-kernel`.
Unchanged Rust/shared inputs reuse the previous release binary; changed inputs
build with `cargo build --release --locked` from the selected release snapshot.

Loggia supervises the kernel. It runs with no arguments by default:

```sh
~/.bun/install/hrc-runtime-current/bin/hrc-kernel
```

`HRC_RUNTIME_DIR` selects the runtime root; otherwise it is
`$HOME/praesidium/var/run/hrc`. The fixed socket is `<runtimeRoot>/hrc-kernel.sock`
and the owner API is `<runtimeRoot>/hrc.sock`. Development overrides are
`--runtime-root PATH` and `--hrc-socket PATH`. A file lock prevents another
kernel from taking over a live socket. The first stdout line is cardo-ui's
`status: serving` ready object, after wire bind and before bootstrap finishes.
Logs go to stderr; stdin EOF is ignored.

Seats use ACP's `scopeRef/lane:laneRef` sessionRef as their natural key. Runtime
replacement changes the attach fence, not the seat row. Seats carry
`status`, `summaryStatus`, `latestEvent: {kind, time, preview?}`, and validated
`contextReading`; clients derive their phase text. Presentation fields are
preserved on runtime nodes, including optional raw `contextReading`.
Turn previews follow HRCMac: command previews use tool input, and results match
their tool-use ID against an exact-session/generation ten-event tail. Missing
context falls back to the result payload. Whitespace collapses and text is
limited to 180 grapheme clusters. Bookkeeping events still win newest-event
selection and carry no turn preview.
Attach descriptors use the presentation's socket and target. A bounded,
read-only tmux window check refuses `resource_unavailable` / `ended` when
that target is gone, without reconciling HRC or changing the projected row.
Legacy bare-session targets remain supported.

`seat.summon` is kernel-scoped (`fences_on: none`), accepts
`{session_ref, fresh, request_id}`, and returns
`{session_ref, host_session_id, runtime_id, status, replayed}`. The caller reuses
its request ID on retry; HRC owns durable replay and request-hash conflicts.
The op calls POST `/v1/declarations/resolve` by scope and then POST
`/v1/runtimes/start`, with reject or suffix policy according to `fresh`.
It resolves no paths, retries nothing, and writes no projected rows. Refusals
retain HRC code/message in error details. Ingest supplies the attachable seat.

The only upstream reads are `/v1/events/page`, `/v1/events/bounded-stream`,
`/v1/events/latest-by-session`, `/v1/events/tail` (bounded tool-result context),
`/v1/presentation/runtimes`, POST `/v1/presentation/seats/read`, and `/v1/sessions`.
The bounded stream supplies wake hints only. Cardo owns replay/cursors,
bootstrapping, expiry and the ten-minute resync. Owner outage retries in place;
owner ledger replacement resets the document; kernel restart opens it empty.

Keep Rust and TS validation separate with `.hookignore` and
`.hookignore-cargo`. Neutral contract/conformance inputs and store migrations
select both legs. New TS paths fail closed into the TS leg. Missing scope files
or ambiguous git scope select validation rather than skipping it.
