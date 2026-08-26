# hrc top — session navigator

**Status:** shipped, with two implementations in the tree.
**Command:** `hrc top` (default) · `hrc top --pi` (replacement candidate)
**Packages:** `packages/hrc-top` (default) · `packages/hrc-pi-top` (candidate)
**Registration:** `packages/hrc-cli/src/cli/register-top.ts`

`hrc top` is the local operator TUI for moving between HRC sessions. It ships
today on the original implementation; a Pi-TUI-based rewrite lives beside it
behind `--pi` and has not been cut over. Both parts below describe live code.

This document consolidates the two former root-level proposals
(`hrc-top-spec.md`, `hrc-pi-top-proposal.md`), which were written before either
implementation landed and were never updated afterward. Read the design
rationale as historical; read the behavior as current. Where the two parts
disagree, the shipped default in Part A wins until the Part B cutover happens.

- **Part A** — session navigator spec; the shipped default.
- **Part B** — Pi TUI replacement candidate behind `--pi`, including the
  migration plan whose cutover and `hrc-top` sunset phases are still open.

---

## Part A — session navigator (shipped default)


### Summary

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

### Goals

- List HRC sessions in a compact terminal UI.
- Let the operator navigate with vi-style movement.
- Show one recommended action for the selected row.
- Explain why that action is recommended.
- Run the correct HRC action for the selected session/runtime state:
  attach, resume, run, focus, inspect, capture, or event tail.
- Keep focus non-mutating.
- Keep the list quiet; put detail in the selected-row panel.

### Non-Goals

- Do not create a new HRC source of truth.
- Do not replace `hrc monitor`, `hrc runtime`, `hrc session`, or `hrcchat`.
- Do not model authorization.
- Do not add provenance hashes or audit-chain mechanics.
- Do not make a full dashboard with every field visible at once.
- Do not mimic `htop` resource-monitor behavior; process metrics are not the
  product center.

### Source Model

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

### Package Boundary

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

### MVP Screen

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

### Display State

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

### Primary Action Policy

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

### Search and Filtering

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

### Vi Movement

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

### Focus View

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

### Ambiguity

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

### Refresh Model

MVP can use periodic polling plus targeted refresh after actions.

Suggested behavior:

- poll aggregate/session/runtime state every 2-5 seconds
- refresh immediately after attach/resume/run exits
- preserve cursor by stable session/runtime identity
- preserve active filter across refreshes
- keep selected row if it still exists in the filtered set
- if selected row disappears, move to nearest surviving row

Later, the event stream can drive incremental updates.

### Message Actions

MVP may show message/reply affordances, but it should not invent a new message
writer. Message actions should preview or shell out to the existing surfaces:

```bash
hrcchat show <message-id>
hrcchat dm <target> --reply-to <message-id>
```

Message preview is read-only. Sending a reply must be an explicit action.

### Command Mode

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

### Post-MVP Candidates

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

### Implementation Notes

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

### Open Questions

- Should `hrc top` default to all projects or infer the current project first?
- Should dormant sessions be visible by default, or behind a saved view?
- Should `Enter` focus or run the primary action? Current proposal keeps
  `Enter` non-mutating and uses `o` for primary action.
- Should focus become a standalone `hrc focus <target>` command later?
- Should the TUI open attach in-place, a split, or a new terminal by default?

---

## Part B — Pi TUI replacement candidate (`hrc top --pi`)


### Summary

`hrc-pi-top` is a replacement candidate for the current `hrc-top`
implementation. It keeps the existing product command:

```bash
hrc top
```

but rewrites the terminal UI/runtime layer around the Pi TUI methodology:
component rendering, a managed terminal lifecycle, robust key/input handling,
overlays, width-aware text utilities, and differential rendering.

This is not a plan to maintain two HRC session navigators. During prove-out,
`hrc-pi-top` may run beside the current implementation behind an explicit flag.
After it is proven gold, `hrc top` should route to `hrc-pi-top` and the current
`packages/hrc-top` implementation should be sunset.

The current `hrc-top` implementation already has the right HRC semantics:
`HrcTargetView` as the row source, target-operator projection, action policy,
filter behavior, nav state, focus/read-only rules, and command execution. The
rewrite should preserve those semantics and replace the hand-rolled TUI shell.

### Decision

Build `packages/hrc-pi-top` as a strangler replacement.

Do not permanently fork behavior. The replacement package should prove that the
Pi TUI architecture can carry the HRC session navigator more cleanly, then become
the implementation behind `hrc top`.

### Why Replace Instead of Incrementally Retrofitting hrc-top

The current `hrc-top` package mixes three concerns in one process loop:

- HRC domain semantics: target read model, row state, action policy, command
  dispatch, focus behavior.
- Screen projection: triage board, selected-row lens, footer, command/filter
  mode text.
- Terminal mechanics: raw mode, input decoding, clear/redraw, cursor restore,
  post-spawn terminal recovery.

The first two layers are valuable. The third layer is the fragile part.

Pi TUI already owns a stronger implementation of terminal mechanics:

- raw-mode lifecycle and restore
- resize handling
- bracketed paste handling
- Kitty keyboard protocol and modified-key handling
- input buffering for partial escape sequences
- terminal report swallowing
- managed focus
- overlays
- synchronized/differential rendering
- width-safe truncation for ANSI, Unicode, and wide glyphs
- single-line and multi-line input components

Retrofitting those pieces into `hrc-top` risks creating an awkward hybrid: a
hand-rolled full-screen app that partially embeds a component framework. A clean
replacement package lets the implementation model be Pi-native from the start
while retaining HRC-owned semantics as the oracle.

### Non-Goals

- Do not change the public command name away from `hrc top`.
- Do not create a long-term second navigator command.
- Do not rewrite HRC session/runtime/continuation semantics.
- Do not use raw `hrc session list` or `hrc runtime list` as the primary row
  model.
- Do not add authorization, audit-chain, provenance, or policy mechanics.
- Do not make this a process/resource dashboard.
- Do not pull in Pi coding-agent session management, themes, auth, model logic,
  or extension APIs.

### Package Boundary

Add:

```text
packages/hrc-pi-top
```

Suggested public entrypoint:

```ts
export async function runHrcPiTop(options: HrcPiTopOptions): Promise<void>
```

`packages/hrc-cli` should keep command registration and process-level option
parsing. During prove-out it should support one explicit opt-in route:

```bash
hrc top --pi
```

or:

```bash
HRC_TOP_IMPL=pi hrc top
```

The final cutover should remove the opt-in requirement:

```bash
hrc top
```

then launches `hrc-pi-top`.

### Dependency Policy

Preferred dependency:

```json
"@earendil-works/pi-tui": "0.80.3"
```

Use the published package, not imports from `~/tools/pi`.

If package availability or release cadence becomes a blocker, vendor only the
minimal TUI primitives with license headers and a documented refresh procedure.
Do not vendor the Pi coding agent. The reusable layer is `packages/tui`.

### Semantic Ownership

HRC owns these parts:

- target source: `HrcTargetView`
- target-state projection: `projectTargetOperatorState`
- action recommendation: attach/resume/run/focus/inspect/capture/tail
- filter semantics
- nav and marks semantics
- focus as a read-only lens
- run-confirmation behavior when a continuation exists
- command execution semantics

Pi TUI owns these parts:

- terminal lifecycle
- input buffering and key parsing
- focus routing
- component render contract
- overlays
- differential/synchronized output
- width-aware terminal string utilities
- input components for filter and command modes

The implementation should keep that boundary visible in code. The Pi package
should not grow new HRC state classification logic.

### Reuse Plan

Do not duplicate HRC semantics.

For the first implementation pass, `hrc-pi-top` may import the current pure
modules from `hrc-top`:

- read model
- action policy
- filter
- nav state
- command executor
- focus model
- triage model

The old `hrc-top` process loop should be frozen except for bug fixes needed to
keep the existing command usable during prove-out.

Before sunset, re-home the reused semantic modules so the old `hrc-top` package
can be deleted cleanly. Two acceptable end states:

- Move the semantic modules into `hrc-pi-top` and delete `hrc-top`.
- Rename `hrc-pi-top` back to `hrc-top` after the old implementation is removed.

The preferred end state is to keep `packages/hrc-pi-top` as the implementation
package and have `hrc-cli` delegate `hrc top` to it. That makes the sunset clear:
old `packages/hrc-top` is gone, while the public command remains stable.

### Architecture

#### Process Entry

`hrc-cli`:

- parses `hrc top` options
- resolves the socket/project/lane/all-project flags
- chooses legacy or Pi implementation during prove-out
- calls `runHrcPiTop()`

`hrc-pi-top`:

- creates `HrcClient`
- loads the initial read model
- creates `TUI(new ProcessTerminal())`
- mounts the root component
- starts polling or subscribing for read-model refreshes
- dispatches actions through existing HRC SDK/CLI-equivalent semantics

#### Root Component

Suggested component tree:

```text
HrcPiTopApp
  HrcTopHeader
  HrcTopBoard
  HrcTopFooter
  overlays:
    HelpOverlay
    ConfirmRunOverlay
    CommandOverlay
    RuntimeCandidatesOverlay
```

The root component owns UI state:

- read model
- nav state
- selected row id
- filter input value
- command input value
- focus mode
- show-all mode
- notice/status message
- pending confirmation
- current overlay

The root component should not own persistent HRC state.

#### Board Component

The board should preserve the existing hrc-top screen semantics:

- triage sections
- collapsed idle tail by default
- `.` expands/collapses idle rows
- selected row pinned within viewport
- active section header reinserted when the viewport begins mid-section
- selected row detail available through focus mode

The board should use Pi TUI width utilities for every fixed column:

- target handle
- state
- last
- action

Do not use string length for visible layout.

#### Filter Mode

Use Pi TUI `Input` for `/`.

MVP behavior stays the existing hrc-top contract:

- `/` enters filter entry
- space-separated terms are ANDed
- match is case-insensitive
- non-matching rows are hidden
- `Esc` exits entry but keeps the filter
- empty filter restores all rows
- footer shows `rows: visible/total`

Do not adopt fuzzy sorting for MVP. Fuzzy search, quoted phrases, and `re:`
queries can be considered after parity.

#### Command Mode

Use Pi TUI `Input` or an overlay for `:`.

MVP commands should call the same command executor as current hrc-top. The
command mode should not invent new verbs during the rewrite.

#### Key Handling

Use Pi TUI key parsing and a small HRC keymap adapter.

Required keys:

| Key | Behavior |
| --- | --- |
| `j` / `k` | next / previous row |
| `gg` / `G` | first / last row |
| `Ctrl-d` / `Ctrl-u` | half-page down / up |
| `Ctrl-f` / `Ctrl-b` | page down / up |
| `/` | enter filter mode |
| `n` / `N` | next / previous filtered viewport movement |
| `m<char>` | mark selected row |
| `'<char>` | jump to mark |
| `:` | command mode |
| `Enter` | focus selected row |
| `o` | run recommended action |
| `a` | attach |
| `r` | resume |
| `R` | run/start, with confirmation if continuation exists |
| `e` | event tail |
| `c` | capture |
| `i` | inspect |
| `?` | help |
| `q` | back, then quit |

Use Pi key support for arrows as aliases where sensible, but keep vi-style keys
as the operator-native surface.

#### Overlays

Use overlays rather than mutating the main board for modal UI:

- help
- run confirmation
- ambiguous runtime candidates
- command palette, if added later
- transient error detail

Overlays should capture focus only when they need input. Read-only overlays can
be non-capturing if the board should remain navigable.

#### Refresh Model

Initial MVP can keep polling:

```text
loadReadModel(client, scope)
```

on a bounded interval.

The Pi implementation should preserve selected row identity across refreshes.
If the selected target disappears, selection should fall to the nearest
surviving row using the current nav-state logic.

Post-MVP can consider SSE/monitor-driven refresh, but that should not block the
replacement.

#### Spawned Actions

Attach/run/resume actions may temporarily leave the TUI process or hand control
to another terminal surface.

The Pi implementation should use the terminal lifecycle hooks instead of
manually juggling raw mode:

- stop or suspend the TUI cleanly before spawn
- restore terminal state after the spawned process exits
- drain/ignore terminal reports that arrive during restoration
- redraw through the TUI render scheduler

This is one of the main reasons to adopt Pi TUI.

### Migration Plan

#### Phase 0: Freeze the Oracle

Before building `hrc-pi-top`, lock down the current behavior with tests around:

- read-model projection
- display state projection
- action policy
- filter behavior
- nav movement and marks
- focus lens model
- command dispatch
- terminal input hygiene cases already covered by current hrc-top tests

These tests are the replacement oracle.

#### Phase 1: Package Scaffold

Create `packages/hrc-pi-top` with:

- `runHrcPiTop(options)`
- dependency on `@earendil-works/pi-tui`
- dependency on `hrc-core`, `hrc-sdk`, and any temporary semantic imports from
  `hrc-top`
- package build/typecheck/test scripts
- root build/test ordering updates

Add `hrc top --pi` or `HRC_TOP_IMPL=pi hrc top`.

#### Phase 2: Component Shell

Build the Pi TUI shell:

- root app component
- board component
- footer component
- filter input
- command input
- help overlay
- notice/status rendering
- polling refresh loop

At this phase, actions can be dry-run or wired only for read-only behavior.

#### Phase 3: Semantic Parity

Wire the existing HRC semantics:

- same row model
- same triage order
- same idle collapse policy
- same action recommendation
- same disabled-action reasons
- same filter counts
- same focus/read-only guarantees
- same command execution results

Add snapshot tests comparing current hrc-top screen-model output to the Pi
component model where practical. The exact ANSI stream need not match; the
semantic screen model must.

#### Phase 4: Action Parity

Wire mutating/operator actions:

- attach
- resume
- run with confirmation
- inspect
- event tail
- capture

Validate that Pi terminal lifecycle handling is correct around spawned actions.

#### Phase 5: Prove Gold

Gold means:

- unit tests pass for `hrc-top`, `hrc-pi-top`, `hrc-core`, `hrc-cli`
- typecheck/build pass
- `hrc top --pi` runs against the live daemon
- `/` filtering works against real targets
- focus mode is read-only
- attach works against a real operator-attachable runtime
- resume either works against a real resumable target or fails clearly when no
  continuation exists
- run confirmation appears when a continuation exists
- quitting restores the terminal cleanly
- post-attach return does not leak raw-mode artifacts or terminal report bytes
- width/layout remains stable in a narrow terminal and a normal-width terminal

Manual smoke testing must use an installed binary, not only unit tests.

#### Phase 6: Cutover

Change `hrc top` to launch `hrc-pi-top` by default.

Keep one short-lived rollback path:

```bash
HRC_TOP_IMPL=legacy hrc top
```

The rollback path is only for immediate fallout during cutover. It should have a
removal date or task.

#### Phase 7: Sunset hrc-top

Remove the old implementation after the Pi implementation survives normal local
use and live validation.

Sunset work:

- delete old process-loop implementation
- remove `packages/hrc-top` from root build/test order, or rename/move the Pi
  package into its place if that end state is chosen
- remove legacy implementation selection from `hrc-cli`
- remove stale terminal-input decoder tests that only apply to old hrc-top
- keep semantic tests by moving them to `hrc-pi-top` or a shared HRC-owned test
  target
- update `AGENTS.md` and repo docs if package names changed
- fold Part A of this document into Part B, or retire Part A outright once cutover is
  complete

Do not leave both implementations active indefinitely.

### Validation Matrix

| Area | Validation |
| --- | --- |
| Build | `bun run build` |
| Typecheck | `bun run typecheck` |
| Unit tests | package tests for `hrc-pi-top`, `hrc-top`, `hrc-core`, `hrc-cli` |
| Boundary checks | `bun run check:boundaries`, `bun run check:manifests` |
| Install | `just install` |
| Live startup | installed `hrc top --pi` against live `hrc-server` |
| Read-only behavior | focus, filter, help, inspect do not mutate sessions/runtimes |
| Attach | attach to a real attachable runtime |
| Resume | resume a real dormant target, or verify clear failure when absent |
| Terminal restore | quit and post-spawn return leave shell usable |
| Layout | narrow and normal terminal widths do not wrap into incoherent output |

### Acceptance Criteria

The replacement is acceptable when:

- `hrc top --pi` gives the same operator decisions as current `hrc top`.
- The command is easier to operate: no flicker, stable filter/command input,
  correct key handling, clean overlays, and reliable terminal restore.
- The HRC semantic modules have one authoritative home.
- The old implementation has a concrete removal path.
- The installed binary has passed live smoke tests.

### Risks

#### Dependency Drift

`@earendil-works/pi-tui` is external to HRC. Pin the exact version and avoid
floating dependency ranges.

#### Over-Adopting Pi Coding-Agent Concepts

Pi coding-agent session selectors and tree selectors are useful references, but
they carry Pi-specific concepts. Do not import or recreate those semantics.

#### Temporary Duality Becomes Permanent

The prove-out flag must have a sunset criterion. If the Pi implementation is not
better, delete it. If it is better, delete the old implementation.

#### Semantic Drift

Any copied or reimplemented action policy can drift. Prefer importing current
semantic modules during prove-out, then move them once at cutover.

#### Terminal Lifecycle Around Spawn

Attach/resume/run transitions are the highest-risk runtime behavior. They need
real installed-binary smoke tests, not only snapshot tests.

### Open Questions

- Should final package identity remain `hrc-pi-top`, or should it be renamed to
  `hrc-top` after old implementation deletion?
- Should cutover use `hrc top --pi`, `HRC_TOP_IMPL=pi`, or both?
- Should the first version use polling only, or should monitor/SSE refresh be
  introduced during the rewrite?
- Should fuzzy/regex query support stay post-MVP, or be included once the Pi
  input component is in place?

### Recommended Answer

Proceed with `packages/hrc-pi-top` as a replacement candidate.

Keep `hrc top` as the product command. Keep HRC semantics authoritative. Use Pi
TUI for the terminal and component methodology. Prove it behind an explicit
switch. Once proven gold, route `hrc top` to the Pi implementation and sunset
the current `packages/hrc-top` implementation.
