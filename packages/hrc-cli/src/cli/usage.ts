// -- Usage --------------------------------------------------------------------

import type { Command } from 'commander'

import { renderCommandRoster } from './command-roster.js'

// Curated prose, head + tail. The COMMANDS roster is NOT hand-listed here — it is generated from the
// live registry by buildInfoText() so it can never drift (the old hand list omitted `info` and
// `session-report`). Inline `hrc <cmd>` / `hrcchat <cmd>` examples and `--flags` in this prose are
// validated by scripts/check-cli-surface.ts against the registry.
const INFO_HEAD = `hrc — HRC operator CLI

ABOUT
  HRC is the local runtime control plane for agent sessions.

  It gives an agent target a stable identity, preserves continuity across
  launches, manages live runtimes, and lets an operator or another agent
  inspect, attach, start, interrupt, or clear that runtime state.

  Use hrc to control HRC itself.
  Use hrcchat to semantically message agents.

CORE MODEL
  HRC tracks three main things:

  target
    The logical agent you want to control.

  session
    The stable continuity record for that target and lane.

  runtime
    A live execution bound to a session.

  In practice:
  use a target handle to select who you mean,
  a session when you care about continuity,
  and a runtime when you need to act on a live process.

ADDRESSING TARGETS
  HRC accepts shorthand target handles:

    <agentId>
    <agentId>@<projectId>
    <agentId>@<projectId>:<taskId>
    <agentId>@<projectId>:<taskId>/<roleName>

  Examples:
    cody
    cody@agent-spaces
    cody@agent-spaces:T-123
    cody@agent-spaces:T-123/reviewer

  A handle may also include a lane:

    <handle>~<lane>

  Examples:
    cody@agent-spaces
    cody@agent-spaces~repair
    cody@agent-spaces:T-123/reviewer~planning

  Notes:
    Managed handle commands such as run/start/attach normally use main when
    lane is omitted.
    Low-level session resolve defaults to main unless --lane is passed.
    If project is omitted, HRC may infer it from the current directory.

SELECTOR GRAMMAR
  Every noun command that takes an identifier accepts the same selector
  grammar (not just monitor). A selector is one of:

    runtime:<id>      a live runtime by runtime ID
    host:<id>         a host session by host-session ID
    session:<ref>     a session by session ref
    scope:<ref>       a scope ref (agent:…:project:…[:task:…])
    msg:<id>          a durable message by message ID
    seq:<n>           a durable message by sequence number
    <handle>          a bare target handle (cody@agent-spaces:T-123)

  Resolution is deterministic: a raw native ID for the command's expected
  type wins first, then explicit prefixes are honored by prefix, then a
  bare handle. Ambiguity is a hard error. Selector acceptance is additive —
  existing raw-ID invocations keep working unchanged.

ORIENTATION SHORTCUTS
  Show whatever a selector resolves to (renders the resolved kind + IDs):
    hrc show <selector>
    hrc show runtime:<id>      hrc show cody@agent-spaces      hrc show seq:42

  List a noun:
    hrc ls runtimes | sessions | launches | messages

COMMON CONTROL FLOWS
  Start or reattach a managed runtime and attach to it:
    hrc run cody@agent-spaces

  Start, reuse, or attach (exact alias of run — NOT attach-only):
    hrc resume cody@agent-spaces

  Reattach without starting a new runtime:
    hrc run --attach-only cody@agent-spaces   (or: hrc attach cody@agent-spaces)

  Start detached without attaching:
    hrc start cody@agent-spaces               (or: hrc run --no-attach …)

  Send a turn to an agent (alias for hrcchat turn):
    hrc turn <target> "Continue."

  Inspect live output:
    hrc capture <runtimeId>

  Stream lifecycle events:
    hrc monitor watch

  Clear continuity / rotate generation:
    hrc session clear-context <hostSessionId>

  Repair run records (maintenance):
    hrc admin runs sweep-zombies | reconcile-active
    (the old 'hrc run sweep-zombies|reconcile-active' still work but are
     deprecated — they print the 'admin runs' replacement to stderr.)

SAFETY RULES
  Prefer stable target handles first.
  Prefer inspection before mutation.
  clear-context changes continuity state.
  interrupt and terminate affect live runtimes.
  tmux kill is destructive to the default tmux server and unclaimed broker-tmux lease servers.

USE HRCCHAT FOR MESSAGING
  hrc is not the semantic messaging interface.

  For agent-to-agent or human-to-agent messaging, use:
    hrcchat info
    hrcchat who
    hrcchat dm cody@agent-spaces "Review the repo."
    hrcchat messages cody@agent-spaces

ENVIRONMENT
  HRC_RUNTIME_DIR   Override runtime root
  HRC_STATE_DIR     Override persistent state root
  ASP_PROJECT       Default project context for shorthand resolution
  ASP_AGENTS_ROOT   Agents root for managed run/start resolution
  HRC_SESSION_REF   Caller identity for HRC-aware child processes`

const INFO_TAIL = `  Low-level (hidden from --help, for API/client use):
    runtime ensure <hostSessionId>   ensure a runtime exists

VERB VOCABULARY
  Going forward nouns are singular and verbs come from a fixed set:
    list  show  watch  wait  start  stop  restart  send  bind  unbind
  Prefer these spellings; 'ls' is the documented shorthand for 'list'.

NEXT STEP
  Run hrc <command> --help for command-specific flags and edge cases.
`

/** Full `hrc info` text: curated prose with a COMMANDS roster generated from the live registry. */
export function buildInfoText(program: Command): string {
  return `${INFO_HEAD}

COMMANDS
${renderCommandRoster(program)}

${INFO_TAIL}`
}

export function printInfo(program: Command): void {
  process.stdout.write(buildInfoText(program))
}

// Curated usage reference. Hand-written (richer than the auto --help), so every command path and
// --flag here is validated against the live registry by scripts/check-cli-surface.ts.
export const USAGE_TEXT = `hrc — HRC operator CLI

Usage: hrc <command> [options]

Commands:
  info                                Show HRC orientation and first-contact guidance
  server [start] [--foreground|--daemon]     Start the HRC server (foreground by default)
  server serve                               Run the server in the foreground (for launchd/systemd)
  server stop [--timeout-ms <n>] [--force]   Stop the HRC daemon only
  server restart [--foreground|--daemon]     Restart the HRC daemon only (daemon by default)
  server status [--json]                     Show daemon/socket/API health state
  server tmux status [--json]         Show HRC tmux socket/session state
  server tmux kill --yes              Kill the HRC tmux server and unclaimed broker-tmux leases
  session resolve --scope <ref> [--lane <ref>] [--create]  Resolve a session; create only with --create
  session list [--scope <ref>] [--lane <ref>]   List sessions
  session get <hostSessionId>         Get a session by host session ID
  session clear-context <hostSessionId> [--relaunch]
  session drop-continuation <hostSessionId> [--reason <text>]
  monitor show [selector] [--json]    Show current HRC monitor snapshot
  monitor watch [selector] [--from-seq <n>|--last <n>] [--follow] [--json|--pretty]
                                     Watch HRC monitor event stream
  monitor wait <selector> --until <condition> [--timeout <duration>] [--stall-after <duration>] [--json]
                                     Wait for a monitor condition and exit with its result
  runtime ensure <hostSessionId> [--provider <provider>] [--restart-style <style>]
  runtime list [--host-session-id <id>] [--transport <transport>] [--status <csv>] [--stale] [--older-than <duration>] [--scope <prefix>] [--json]
                                     List runtimes
  runtime inspect <runtimeId> [--json] Inspect one runtime
  runtime sweep [--transport <t>] [--older-than <duration>] [--status <csv>] [--scope <prefix>] [--drop-continuation] [--dry-run|--yes] [--json]
                                     Sweep stale runtimes
  runtime capture <runtimeId>         Capture tmux pane text
  runtime interrupt <runtimeId>       Interrupt a runtime
  runtime terminate <runtimeId> [--drop-continuation|--no-drop-continuation]
                                     Terminate a runtime session
  runtime adopt <runtimeId>           Adopt a dead/stale runtime
  launch list [--host-session-id <id>] [--runtime-id <id>]  List launches
  start <scope> [prompt] [--force-restart] [--new-session] [--dry-run]
  run <scope> [prompt] [--force-restart] [--no-attach] [--dry-run]
  top [--project <id>] [--all-projects] [--pi]  Open the HRC session navigator
  run sweep-zombies [--older-than <duration>] [--dry-run|--yes] [--json]
  run reconcile-active [--older-than <duration>] [--dry-run|--yes] [--json]
  turn <target> [prompt]              Alias for hrcchat turn; all flags forwarded verbatim
  inflight send <runtimeId> --run-id <runId> --input <text> [--input-type <type>]
  capture <runtimeId>                 Capture tmux pane text
  attach <scope> [--dry-run]          Attach to the latest active tmux runtime for a scope
  attach <runtimeId>                  Print tmux attach descriptor JSON
  surface bind <runtimeId> --kind <kind> --id <surfaceId>
  surface unbind --kind <kind> --id <surfaceId> [--reason <reason>]
  surface list <runtimeId>            List active surface bindings for a runtime
  bridge target --bridge <bridge> (--host-session <id> | --session-ref <sessionRef>) [--transport <t>] [--target <tgt>]
  bridge deliver-text --bridge <bridgeId> --text <text> [--enter] [--oob-suffix <s>]
  bridge register <hostSessionId> --transport <name> --target <value>  (compat)
  bridge deliver <bridgeId> --text <text>                              (compat)
  bridge list <runtimeId>             List active local bridges for a runtime
  bridge close <bridgeId>             Close a local bridge
`

export function printUsage(): void {
  process.stderr.write(USAGE_TEXT)
}
