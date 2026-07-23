---
id: hrc-runtime/hrcchat-messaging
title: hrcchat messaging guide
kind: guide
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# hrcchat messaging guide

`hrcchat` is HRC's directed-messaging CLI: durable DMs and tracked "turns"
to agent sessions. Installed to `~/.bun/bin/hrcchat`, source in
`packages/hrcchat-cli`. Use `hrc` to control HRC itself (runtimes, server,
monitor); use `hrcchat` to message agents. Target-handle syntax
(`agentId@projectId:taskId/roleName~lane`) is shared with `hrc` — see
`hrc-runtime/target-handles`.

## Sending a DM

```bash
# Fire-and-record a durable DM:
hrcchat dm cody@agent-spaces "Review the repo."
hrcchat dm cody@agent-spaces -            # body from stdin

# Capture the dispatch envelope as JSON (for the wait flow, below):
hrcchat dm --json cody@agent-spaces -

# Dispatch as a tracked turn and stream ndjson progress on an interval:
hrcchat dm cody@agent-spaces --follow 30s "Long task."
```

`dm` positional args: `<target>` (a target handle, or the literal strings
`"human"` or `"system"`), `[message]` (use `-` for stdin). Options:
`--json`, `--respond-to <human|agent|system>`, `--reply-to <id>`, `--mode <auto|headless|nonInteractive>`, `--file <path>`, `--follow <duration>`.

The `--json` envelope exposes `messageId`, `seq`, `to`, `sessionRef`,
`runtimeId`, `turnId`, and a `request.execution` block — this is the
shape scripts should persist for later correlation.

## Scopes: DMs vs. tracked turns

- `hrcchat dm` records a durable message and dispatches it toward the
  target's live/summoned runtime.
- `hrcchat turn` (alias: `hrc turn`) dispatches tracked work and streams
  progress; it uses distinct, intentional exit codes (`1`, `3`, `4`, `5`,
  `130`) for dispatch/turn outcomes — see `hrcchat turn --help`.
- `hrcchat send` writes raw keystrokes into a live tmux runtime. It is
  **not** a turn — no message record, no reply correlation.

## Reply threading

`dm` accepts `--reply-to <messageId>` to anchor a message as a reply to an
earlier one, building a threaded conversation. If the anchor is stale or
unresolvable (e.g. the parent message no longer exists), the daemon rejects
it with a `malformed_request{field: 'replyToMessageId'}` error; `hrcchat dm` catches specifically this unknown-anchor case and retries the same send
without threading, warning on stderr (`--reply-to anchor "<id>" is unknown; sending without threading`) rather than failing the whole dispatch. Any
other validation failure surfaces normally.

## The `dm --wait` replacement flow

The old `hrcchat dm --wait` flag was removed. The canonical replacement
splits request creation from response waiting:

```bash
envelope="$(hrcchat dm --json cody@agent-spaces - <<'EOF'
Please handle the requested task.
EOF
)"
message_id="$(printf '%s\n' "$envelope" | jq -r '.messageId')"
hrc monitor wait "msg:${message_id}" --until response --timeout 30m
```

For scripts that need full dispatch context, persist the envelope and
extract fields before waiting:

```bash
hrcchat dm --json cody@agent-spaces - <<'EOF' > /tmp/dm-envelope.json
Please handle the requested task.
EOF
jq '{messageId, seq, sessionRef, runtimeId, turnId}' /tmp/dm-envelope.json
hrc monitor wait "msg:$(jq -r '.messageId' /tmp/dm-envelope.json)" \
  --until response --timeout 30m
```

`response` waits require exactly one `msg:` (or `seq:`) selector — see
`hrc-runtime/cli-surface` for the full `monitor wait` exit-code table.

## The rest of the hrcchat surface

- `hrcchat messages` — list/query durable messages.
- `hrcchat show <seq-or-id>` — show one message by sequence number or id.
- `hrcchat send` — raw keystrokes into a live tmux runtime (not a turn).
- `hrcchat peek` — inspect a target without sending anything.
- `hrcchat who [--discover] [--all-projects] [--json]` — list known
  targets with a state icon (`?` discoverable, `-` summoned, `*` bound,
  `!` busy, `x` broken), capability flags (`dm`/`send`/`peek` readiness),
  lane suffix when non-`main`, generation, and live runtime
  transport/status when present.
- `hrcchat summon <target> [--json]` — ensure a target's session/runtime
  exists (calls the daemon's `ensureTarget`), printing the resolved
  `sessionRef`, state, host session id (if any), generation, and
  dm/send/peek capability readiness. This is the way to pre-warm a target
  before sending it a DM without attaching a TUI.
- `hrcchat info` — target/session diagnostic info.
- `hrcchat doctor` — health/diagnostic checks for the messaging surface.

## Frame rendering shared with Discord

`hrcchat-cli` terminal output and ACP's `gateway-discord` Discord output
both consume the same RenderFrame contract (`hrc-frame-render`), with
shared tool-emoji/action-line/admission-label semantics in
`agent-action-render`. A behavior fixed in one terminal-facing renderer
should be checked against the shared contract, not hand-duplicated into the
Discord-facing one (that assertion belongs in the ACP repo if it is
Discord-specific).

## Deprecated → current migration

`hrcchat status`, `hrcchat watch`, `hrcchat wait`, and `hrcchat dm --wait`
have all been **removed** and reject with an error
(`error: unknown option '--wait'`, etc.). Use `hrc monitor show|watch|wait`
with selectors instead — see `hrc-runtime/cli-surface`.

Source of truth: command registration in
`packages/hrcchat-cli/src/main.ts`; individual command implementations
under `packages/hrcchat-cli/src/commands/`.
