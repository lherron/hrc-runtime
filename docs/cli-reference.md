# HRC CLI workflows

Agents use `prae` for seat coordination, observations and task or room work.
Use `hrc` for the operator and daemon surfaces. `hrc <command> --help`
shows the options supported by the installed CLI. `hrc info` explains the
agent and human views, and `hrc admin --help` lists maintenance commands.

## Start and attach

From a real terminal, `hrc run cody@agent-spaces` starts or reuses the
seat and attaches to it. `hrc start cody@agent-spaces` provisions without
attaching the invoking terminal. `hrc attach cody@agent-spaces` attaches to
an existing live seat. A runtime ID passed to `hrc attach` prints the
runtime's attach descriptor.

`run` and attached `resume` ask ASP for presentation. If a live runtime
was born without it, HRC refuses with `stale_context` and reports
`replacementRequired: true`. The live runtime is left intact. Similarly,
`start --no-viewer` and `--app-server-viewer` choose different Codex
execution/presentation routes at birth. A conflicting live presentation is
refused before replacement.

For a fresh roster claim, use `start --on-conflict suffix` to choose the
next free slot or `--on-conflict reject` to claim one exact scope. Read the
actual scope from `claim`. Use the same `--idempotency-key` and request when
retrying an uncertain claim. A changed request conflicts. A newer claim that
has recycled the seat supersedes the recorded result.

`start -p 'prompt'` claims or starts the runtime and delivers a separate
turn. `--wait completed` waits on a guarded turn and prints that turn's
answer. For HTTP clients, keyed claim-and-start binds
`runtimeIntent.initialPrompt` into the claim. Without `coldBirth`, the
client follows it with a separately admitted turn. With
`coldBirth: {"promptMode":"append-to-priming"}`, a birth carries the prompt
as part of priming, under the turn-admission lease. Check
`initialPrompt.delivered`, `runId` and `submissionId` to prove delivery.
An already live runtime or a self-brokered birth reports
`initialPrompt.delivered: false`. See
`crates/hrc-native/src/server/broker/start.rs#Claim.start`.

The [target handle contract](target-handles.md) describes scope and lane
identity. The [operations runbook](operations-runbook.md#viewer-and-mail-delivery-ownership)
describes the viewer and mail owners.

### Place a viewer tab

Set `--viewer-window console` on start to use a window that carries the
`console` key. Stamp the window itself before starting the per-user viewer.

```sh
ghostmux list-windows --json
ghostmux metadata set --window-id <windowId> \
  '{"hrc_role":"headless-sessions-window","hrc_window_key":"console"}'
ghostmux list-windows --meta hrc_window_key=console --json
```

Closing a tab leaves the key intact. The viewer creates a new keyed window if
the keyed window closes. Repeat the stamp after a Ghostty restart to reuse a
specific window.

## Follow a turn

For a direct HRC turn, the default dispatch joins a running turn or starts
one. `--queue` schedules its own turn behind the active one. `--wait final`
waits on the admitted turn. The admission receipt identifies work to observe.
Verify the result from the terminal turn event.

```sh
hrc turn --attach cody@hrc-runtime --stacked 20s
hrc monitor wait cody@hrc-runtime --until turn-finished --since <hrcSeq> --timeout 30s --json
```

`turn --attach` only observes. It requires exactly one admitted active run
and reports exit 6 if there is no single run. Stacked catch-up begins with the
complete replay boundary or the turn's terminal frame if the run ends while
the observer subscribes.

Use `hrc monitor events <invocationId> --seq 20..80 --ndjson` for
post-mortem evidence, including retired runtimes. These sequences belong to
the broker invocation. Monitor conditions use the HRC lifecycle ledger's
`hrcSeq`. See the [monitor contract](monitor-spec.md) for condition and exit
semantics.

## Session continuity

A runtime restart can preserve the conversation even though the process
changes. `hrc restart <scope>` rotates the session and starts with no
continuation. It refuses a busy seat unless explicitly forced.
`hrc resume <scope>` uses the stored continuation. For an explicit
continuation barrier, use `hrc session drop-continuation <hostSessionId>`.

For self-restart, create a pending HRC seat handoff through
`prae seat handoff create`, arm `prae seat restart --handoff-id <id>`,
then end the turn. The arm binds to that turn's terminal event. The
successor reads and acknowledges the handoff. Use
`prae seat restart --cancel` to disarm it.
