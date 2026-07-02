# hrc-top Session Navigator Proposal

## Summary

`hrc top` launches the HRC session navigator: a local operator TUI for moving
between HRC sessions. It is a session switcher, not a status dashboard or an
`htop` clone. Its primary job is to answer one question quickly: where should
the operator go next?

The launch point is the `hrc` CLI:

```bash
hrc top
```

The implementation package is:

```text
packages/hrc-top
```

`hrc-cli` should own command registration and process entry. `hrc-top` should
own the TUI, projection model, action policy, key handling, and renderer.

This is a simple local development utility. Do not add authentication,
provenance hashes, policy attestations, or other safety theater.

Daedalus review note: Daedalus recommended `hrc nav` as the command name, but
Lance specified `hrc top`. This spec keeps `hrc top` as the command and
`packages/hrc-top` as the package boundary.

Naming note: use `hrc-top`, not `hrc-htop`. The internal product language should
be "session navigator" so the implementation stays centered on navigation and
explicit session actions rather than process/resource monitoring.

## Goals

- List HRC sessions in a compact terminal UI.
- Let the operator navigate with vi-style movement.
- Show one recommended action for the selected row.
- Explain why that action is recommended.
- Run the correct HRC action for the selected session/runtime state:
  attach, resume, run, focus, inspect, capture, or event tail.
- Keep focus non-mutating.
- Keep the list quiet; put detail in the selected-row panel.

## Non-Goals

- Do not create a new HRC source of truth.
- Do not replace `hrc monitor`, `hrc runtime`, `hrc session`, or `hrcchat`.
- Do not model authorization.
- Do not add provenance hashes or audit-chain mechanics.
- Do not make a full dashboard with every field visible at once.
- Do not mimic `htop` resource-monitor behavior; process metrics are not the
  product center.

## Source Model

`hrc-top` should start from the existing HRC target projection, then enrich only
where the selected view needs more detail.

- Primary rows: HRC target projection / `HrcTargetView`
- Existing consumer reference: `hrcchat who`
- Sessions: `hrc session list --json`, for drill-down/enrichment
- Runtimes: `hrc runtime list --json`, for drill-down/enrichment
- Aggregate daemon state: `hrc monitor show --json`
- Targeted detail, when selected: runtime inspect, monitor watch, capture, or
  target view routes if available through the SDK.

The conceptual split must stay clear:

- Session: identity and continuity.
- Runtime: live process and attachability.
- Continuation: resume capability.

The TUI should not use raw historical session/runtime tables as the primary row
model. Those tables are large and include stale history. `HrcTargetView` already
projects active target heads, state, runtime, continuation, and capabilities.

The TUI can cache and refresh its local read model, but it must not become
persistent state.

## Package Boundary

`packages/hrc-top` should expose a small programmatic entrypoint, for example:

```ts
export async function runHrcTop(options: HrcTopOptions): Promise<void>
```

`packages/hrc-cli` should register:

```text
hrc top
```

and delegate to `hrc-top`.

Suggested package responsibilities:

| Package | Responsibility |
| --- | --- |
| `hrc-cli` | command registration, option parsing, process entry |
| `hrc-top` | TUI state machine, rendering, keymap, action policy |
| `hrc-sdk` | daemon API client |
| `hrc-core` | shared DTOs and status types |

Avoid putting TUI-specific projection logic inside `hrc-cli`. The CLI command
should stay thin.

Avoid duplicating target-readiness classification inside `hrc-top`. If a display
state needs logic beyond `HrcTargetView`, put that logic in a shared projection
helper rather than forking it in the TUI.

## MVP Screen

The MVP should be dense and calm. Do not overfit it with columns.

```text
HRC TOP                                      healthy  43 live  18 dormant

  target                                      state      last      action
> cody@hrc-runtime:codex-019f...              busy       2m        attach
  daedalus@wrkq:T-05412                       input      9m        attach
  cody@taskboard:T-05322                      dormant    2d        resume
  clod@agent-spaces:primary                   ready      18m       attach
  smokey@agent-control-plane:primary          stale      1h        resume
  cody@wrkq:T-05067                           broken     6d        focus

──────────────────────────────────────────────────────────────────────────────
cody@hrc-runtime:codex-019f... / main
primary: attach rt-597a7314
reason: live operator-attachable runtime is busy
filter: none
keys: j/k move  enter focus  o default  a attach  r resume  / filter  : command
```

The bottom panel is contextual and should stay concise. It should show:

- selected target/lane
- primary action
- reason for the primary action
- current filter
- minimal key hints

Detailed JSON, event logs, runtime candidates, and command traces belong behind
actions, not in the default list.

## Display State

Rows should use operator language instead of raw DB language, but that language
must be derived from `HrcTargetView` or a shared projection helper. `hrc-top`
must not independently decide whether a target is `busy`, `dormant`, or
`broken` from raw `session list` / `runtime list` records.

| UI State | Meaning |
| --- | --- |
| `busy` | target projection says the target is busy, or selected runtime detail is busy |
| `input` | selected runtime detail is `awaiting_input` |
| `ready` | target is attachable/bound and idle |
| `starting` | runtime exists but attach may race |
| `headless` | live runtime exists but is not operator-attachable |
| `dormant` | target projection reports dormant/resumable continuity |
| `stale` | stale/dead/terminated runtime exists, but continuation is available |
| `broken` | target projection reports broken/non-resumable continuity |
| `ambiguous` | selection maps to multiple plausible runtimes/actions |

Attachability must not be inferred from `transport=tmux` alone. Use the
operator attach surface:

- `tmux` / `ghostty` runtime where HRC exposes an attach descriptor
- broker runtime with `presentation.kind = "tmux-tui"`

Headless durable runtimes may live in tmux internally and still be
non-attachable.

## Primary Action Policy

The `action` column is the recommended action. Pressing `o` runs it.

| Condition | Primary Action | Command |
| --- | --- | --- |
| target view exposes live operator-attachable runtime, status `ready` | attach | `hrc attach <runtimeId>` |
| target view exposes live operator-attachable runtime, status `busy` | attach | `hrc attach <runtimeId>` |
| target view exposes live operator-attachable runtime, status `awaiting_input` | attach | `hrc attach <runtimeId>` |
| runtime status `starting` | focus/wait | focus selected row and tail until attachable |
| live runtime exists but is not attachable | focus | focus plus event/capture options |
| target view reports dormant and continuation exists | resume | `hrc resume <handle>` |
| terminal/stale/dead runtime and valid continuation exists | resume | `hrc resume <handle>` |
| active target, no runtime, no continuation | run | `hrc run <handle>` |
| broken or ambiguous state | focus | non-mutating inspect lens |

`hrc resume` requires a captured, non-invalidated continuation and must fail
clearly if none exists. `hrc top` should not turn a failed resume into an
implicit fresh launch.

`hrc run` is the start/reuse/attach path. It is appropriate only when resume is
not the semantic action.

`focus` is non-mutating. It changes what the TUI is looking at. It does not
start, resume, attach, interrupt, terminate, or send input.

Search, filter, sort, refresh, focus, inspect, and event preview are read-only.
Resume, attach, run, and message/reply actions must be explicit operator actions
mapped to existing HRC/hrcchat commands or SDK calls with the same semantics
available outside the TUI.

Destructive verbs are out of MVP:

- terminate
- drop continuation
- clear context
- sweeps
- forced restart

## Search and Filtering

`/` is a text-based row filter, not only a cursor search.

When the operator types `/wrkq cody`, rows that do not match are hidden. The
cursor remains within the filtered row set.

Filter behavior:

- Match against visible target text, agent, project, task, lane, state, action,
  runtime id, host session id, and continuation provider/key when loaded.
- Case-insensitive by default.
- Space-separated terms are ANDed.
- `Esc` exits filter entry but keeps the filter.
- Empty filter restores all rows.
- `n` and `N` move through matches only when a filter is active and the filtered
  set is larger than the viewport; otherwise they are no-ops or repeat the last
  command-line search if command mode later adds one.

The footer should always show the active filter:

```text
filter: wrkq cody   rows: 4/86
```

Post-MVP can add structured filters in command mode. MVP `/` should stay simple
and text-first.

## Vi Movement

The keymap should feel native to a terminal operator.

| Key | Behavior |
| --- | --- |
| `j` / `k` | next / previous row |
| `gg` / `G` | first / last row |
| `Ctrl-d` / `Ctrl-u` | half-page down / up |
| `Ctrl-f` / `Ctrl-b` | page down / up |
| `h` / `l` | collapse / expand group, or move pane focus if panes exist |
| `/` | enter filter mode |
| `n` / `N` | next / previous filtered match or search hit |
| `m<char>` | mark selected row |
| `'<char>` | jump to mark |
| `:` | command mode |
| `q` | back, then quit at top level |

Action keys:

| Key | Action |
| --- | --- |
| `Enter` | focus selected row |
| `o` | run recommended action |
| `a` | attach if available |
| `r` | resume if available |
| `R` | run/start path; confirm first if a continuation exists |
| `e` | show event tail |
| `c` | capture runtime output |
| `i` | inspect selected row |
| `?` | key help |

Disabled actions should explain why in the footer rather than failing silently.

## Focus View

Focus is the selected-row lens. It should show enough to decide the next action:

- exact target handle
- session ref and lane
- host session id
- latest runtime id, if any
- primary action and reason
- disabled actions and reasons
- latest event summary
- runtime ambiguity candidates, if any
- canonical command preview for explicit actions

Focus mode should be useful even when no action is available.

## Ambiguity

If a handle maps to multiple plausible runtimes, `hrc top` should not guess.
Show an ambiguity state and make the operator choose a runtime candidate.

The TUI can still recommend a candidate when HRC has a clear newest live
operator-attachable runtime, but it should display that it is resolving an
ambiguous handle to a concrete runtime id.

Runtime-id commands are preferred for attach:

```bash
hrc attach rt-597a7314-...
```

because they avoid selector ambiguity.

## Refresh Model

MVP can use periodic polling plus targeted refresh after actions.

Suggested behavior:

- poll aggregate/session/runtime state every 2-5 seconds
- refresh immediately after attach/resume/run exits
- preserve cursor by stable session/runtime identity
- preserve active filter across refreshes
- keep selected row if it still exists in the filtered set
- if selected row disappears, move to nearest surviving row

Later, the event stream can drive incremental updates.

## Message Actions

MVP may show message/reply affordances, but it should not invent a new message
writer. Message actions should preview or shell out to the existing surfaces:

```bash
hrcchat show <message-id>
hrcchat dm <target> --reply-to <message-id>
```

Message preview is read-only. Sending a reply must be an explicit action.

## Command Mode

MVP can include only a minimal command mode or defer it. If included, start with:

```text
:attach
:resume
:run
:tail
:capture
:inspect
:filter <text>
:clear-filter
:quit
```

Command mode should be a convenience wrapper over the same action policy, not a
second behavior path.

## Post-MVP Candidates

Keep:

- saved views: `live`, `needs-input`, `dormant`, `my-project`, `stale`
- split-pane event tail that follows selection
- ambiguity resolver for multi-runtime handles
- return stack: after attach exits, reopen `hrc top` at the same row
- terminal integration: current pane, split pane, new Ghostty tab, or reuse an
  existing surface
- health warnings: PTY pressure, daemon restart age, stale broker lease, missing
  continuation artifact
- recent command log with command, exit status, and elapsed time
- fuzzy launcher: type fragments like `cody wrkq 5067` and jump directly

Defer:

- batch actions over marked rows
- persisted layouts
- custom themes
- event-stream-only live model
- external plugin hooks

Cut unless a concrete need appears:

- auth
- provenance hashes
- policy/audit attestation
- separate persistent state database
- heavyweight dashboard metrics

## Implementation Notes

Suggested internal modules:

```text
packages/hrc-top/src/index.ts
packages/hrc-top/src/read-model.ts
packages/hrc-top/src/action-policy.ts
packages/hrc-top/src/filter.ts
packages/hrc-top/src/keymap.ts
packages/hrc-top/src/render.ts
packages/hrc-top/src/commands.ts
```

Unit-test the action policy and filter behavior independently from the terminal
renderer.

Important tests:

- row projection consumes `HrcTargetView` or a shared projection helper
- row projection preserves `sessionRef`, target state, runtime id/status,
  continuation presence, and capabilities without recomputing
  busy/dormant/broken from raw session/runtime lists
- attachable busy runtime recommends attach by runtime id
- awaiting-input runtime recommends attach
- starting runtime recommends focus/wait
- dormant target with continuation recommends resume
- stale/dead/terminated runtime with continuation recommends resume only through
  explicit `hrc resume`
- no runtime and no continuation recommends run only for active target
- broken continuity recommends focus/inspect only
- `transport=headless` with `presentation.kind=tmux-tui` is attachable
- `transport=tmux` with `presentation.kind=none` is not assumed attachable
- `/` filter hides non-matching rows
- filter preserves selection when possible
- `j/k`, `gg/G`, page movement, marks, and jump behavior respect the filtered set
- search/filter/sort/refresh/focus/inspect do not call mutating SDK methods
- `hrc top --help` exists
- existing `hrc session list`, `hrc runtime list`, `hrc ls sessions`, and
  `hrcchat who` behavior remains unchanged

Manual installed smoke after implementation:

- run `just install`
- run `hrc top` against the live daemon
- verify it renders current HRC targets at operator scale
- verify `/` hides non-matching rows and preserves movement within the filtered
  set
- verify the TUI exits cleanly without changing session/runtime counts except
  normal concurrent activity
- if attach is included in MVP, attach to one live attachable runtime and return
  to the TUI cleanly

## Open Questions

- Should `hrc top` default to all projects or infer the current project first?
- Should dormant sessions be visible by default, or behind a saved view?
- Should `Enter` focus or run the primary action? Current proposal keeps
  `Enter` non-mutating and uses `o` for primary action.
- Should focus become a standalone `hrc focus <target>` command later?
- Should the TUI open attach in-place, a split, or a new terminal by default?
