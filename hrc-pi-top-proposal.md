# hrc-pi-top Replacement Proposal

## Summary

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

## Decision

Build `packages/hrc-pi-top` as a strangler replacement.

Do not permanently fork behavior. The replacement package should prove that the
Pi TUI architecture can carry the HRC session navigator more cleanly, then become
the implementation behind `hrc top`.

## Why Replace Instead of Incrementally Retrofitting hrc-top

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

## Non-Goals

- Do not change the public command name away from `hrc top`.
- Do not create a long-term second navigator command.
- Do not rewrite HRC session/runtime/continuation semantics.
- Do not use raw `hrc session list` or `hrc runtime list` as the primary row
  model.
- Do not add authorization, audit-chain, provenance, or policy mechanics.
- Do not make this a process/resource dashboard.
- Do not pull in Pi coding-agent session management, themes, auth, model logic,
  or extension APIs.

## Package Boundary

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

## Dependency Policy

Preferred dependency:

```json
"@earendil-works/pi-tui": "0.80.3"
```

Use the published package, not imports from `~/tools/pi`.

If package availability or release cadence becomes a blocker, vendor only the
minimal TUI primitives with license headers and a documented refresh procedure.
Do not vendor the Pi coding agent. The reusable layer is `packages/tui`.

## Semantic Ownership

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

## Reuse Plan

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

## Architecture

### Process Entry

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

### Root Component

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

### Board Component

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

### Filter Mode

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

### Command Mode

Use Pi TUI `Input` or an overlay for `:`.

MVP commands should call the same command executor as current hrc-top. The
command mode should not invent new verbs during the rewrite.

### Key Handling

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

### Overlays

Use overlays rather than mutating the main board for modal UI:

- help
- run confirmation
- ambiguous runtime candidates
- command palette, if added later
- transient error detail

Overlays should capture focus only when they need input. Read-only overlays can
be non-capturing if the board should remain navigable.

### Refresh Model

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

### Spawned Actions

Attach/run/resume actions may temporarily leave the TUI process or hand control
to another terminal surface.

The Pi implementation should use the terminal lifecycle hooks instead of
manually juggling raw mode:

- stop or suspend the TUI cleanly before spawn
- restore terminal state after the spawned process exits
- drain/ignore terminal reports that arrive during restoration
- redraw through the TUI render scheduler

This is one of the main reasons to adopt Pi TUI.

## Migration Plan

### Phase 0: Freeze the Oracle

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

### Phase 1: Package Scaffold

Create `packages/hrc-pi-top` with:

- `runHrcPiTop(options)`
- dependency on `@earendil-works/pi-tui`
- dependency on `hrc-core`, `hrc-sdk`, and any temporary semantic imports from
  `hrc-top`
- package build/typecheck/test scripts
- root build/test ordering updates

Add `hrc top --pi` or `HRC_TOP_IMPL=pi hrc top`.

### Phase 2: Component Shell

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

### Phase 3: Semantic Parity

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

### Phase 4: Action Parity

Wire mutating/operator actions:

- attach
- resume
- run with confirmation
- inspect
- event tail
- capture

Validate that Pi terminal lifecycle handling is correct around spawned actions.

### Phase 5: Prove Gold

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

### Phase 6: Cutover

Change `hrc top` to launch `hrc-pi-top` by default.

Keep one short-lived rollback path:

```bash
HRC_TOP_IMPL=legacy hrc top
```

The rollback path is only for immediate fallout during cutover. It should have a
removal date or task.

### Phase 7: Sunset hrc-top

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
- update `hrc-top-spec.md` or supersede it with this proposal once cutover is
  complete

Do not leave both implementations active indefinitely.

## Validation Matrix

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

## Acceptance Criteria

The replacement is acceptable when:

- `hrc top --pi` gives the same operator decisions as current `hrc top`.
- The command is easier to operate: no flicker, stable filter/command input,
  correct key handling, clean overlays, and reliable terminal restore.
- The HRC semantic modules have one authoritative home.
- The old implementation has a concrete removal path.
- The installed binary has passed live smoke tests.

## Risks

### Dependency Drift

`@earendil-works/pi-tui` is external to HRC. Pin the exact version and avoid
floating dependency ranges.

### Over-Adopting Pi Coding-Agent Concepts

Pi coding-agent session selectors and tree selectors are useful references, but
they carry Pi-specific concepts. Do not import or recreate those semantics.

### Temporary Duality Becomes Permanent

The prove-out flag must have a sunset criterion. If the Pi implementation is not
better, delete it. If it is better, delete the old implementation.

### Semantic Drift

Any copied or reimplemented action policy can drift. Prefer importing current
semantic modules during prove-out, then move them once at cutover.

### Terminal Lifecycle Around Spawn

Attach/resume/run transitions are the highest-risk runtime behavior. They need
real installed-binary smoke tests, not only snapshot tests.

## Open Questions

- Should final package identity remain `hrc-pi-top`, or should it be renamed to
  `hrc-top` after old implementation deletion?
- Should cutover use `hrc top --pi`, `HRC_TOP_IMPL=pi`, or both?
- Should the first version use polling only, or should monitor/SSE refresh be
  introduced during the rewrite?
- Should fuzzy/regex query support stay post-MVP, or be included once the Pi
  input component is in place?

## Recommended Answer

Proceed with `packages/hrc-pi-top` as a replacement candidate.

Keep `hrc top` as the product command. Keep HRC semantics authoritative. Use Pi
TUI for the terminal and component methodology. Prove it behind an explicit
switch. Once proven gold, route `hrc top` to the Pi implementation and sunset
the current `packages/hrc-top` implementation.
