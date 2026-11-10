# CLI workflow checks

`just cargo-check` runs the frozen grammar differential and its status,
metrics, transport-error, native-surface, daemon-entrypoint and caller checks.
Obligation labels in the grammar report never mean a workflow ran.

Hand-run native checks (no recording mode):

- `metrics_report.py --binary BIN --artifacts DIR`: immutable metrics golden,
  every writer's day files read once, malformed/torn input and duration errors.
- `session_meta_retire.py --binary BIN --artifacts DIR`: immutable output and
  stored-state golden, on a private native owner with fake aspd and stub broker.
- `transcript_search.py --binary BIN --root /tmp/OWNED --artifacts DIR`: immutable
  search results, forwarding requests and clocks; requires that scratch's
  `run/hrc.sock`, `state/state.sqlite` and private declaration resolver `aspd.sock`.
- `monitor_idle.py --binary BIN --artifacts DIR`: Linux SQLite-open observer,
  event/message notification, watch/wait deadlines and event-loop resolution.

The remaining manual drivers are listed for follow-up in T-13069's disposition
artifact. They require owned seats, an isolated authority, retained SDK client
qualification or model calls and have not been qualified without Bun.
The listed controls driver holds their existing clock-normalization helper.
`copied_release.py` remains only for the listed server-start driver; retire it
when that last caller moves. Never point these drivers at a shared/live node.
