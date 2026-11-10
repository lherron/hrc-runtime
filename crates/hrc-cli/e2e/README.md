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
- `controls.py`, `restart.py`, `restartme.py`, `resume.py`, `send.py`,
  `summon.py`, `server_lifecycle.py`: each accepts `--binary BIN --artifacts DIR`.
  BIN needs an `hrc-pty` sibling. Each creates and removes a short private /tmp
  root with a native owner, project, agent declaration, compiler socket and wrkqd.
  Real hrcpty supervisors and the deterministic substrate broker execute turns;
  no model or installed owner is used. Evidence includes raw rows, broker/lease
  status, opened stores, authority locator and process/root cleanup readback.
  All lifecycle phases run by default (`--lifecycle` remains accepted).
- `turn_live.py --binary BIN --artifacts DIR --mode stream|wait|stacked` skips
  clearly without model configuration. To qualify a real model, also pass
  `--harness-config /path/to/asp-targets.toml --aspd-socket /named/compiler.sock`.
  The config must declare `targets.tabularasa` and, for stacked mode, the
  summarizer it uses. It is copied into the private project; the explicit
  compiler socket replaces the default fake compiler. Stream/final/stacked
  rendering, terminal ledger and owned-runtime cleanup assertions remain.
  A skip is not model qualification.

`native_seat.py` composes the native scratch/isolation and substrate helpers.
`seat_broker.py` imports an unchanged copy of the substrate broker and supplies
nonempty turn IDs and truthful active-turn probes. This keeps restartme's arm,
cancel and terminal facts bound to the same actual turn.

`annotations.py` retains SDK client qualification. `copied_release.py` remains
untouched for five native daemon drivers: lifecycle_actions, lifecycle_credentials,
lifecycle_peer, lifecycle_rows and server_owner. It is the explicit temporary
exception to the executable Bun/retiring-package scan until those callers retire.
Frozen provenance in `fixtures/` remains immutable. Never point a manual driver
at a shared/live node.
