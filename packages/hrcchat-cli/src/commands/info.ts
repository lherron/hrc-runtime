import type { Command } from 'commander'

import { renderCommandRoster } from '../command-roster.js'

// Curated prose. The COMMANDS roster is NOT listed here — it is generated from the live registry by
// buildInfoText() so it can never drift (this block previously omitted `turn`). Inline command
// examples in this prose are validated by scripts/check-cli-surface.ts: every `hrcchat <cmd>` /
// `hrc <cmd>` and `--flag` must resolve to a real registered command/option.
const INFO_HEAD = `hrcchat — semantic directed messaging for HRC agents

ABOUT
  hrcchat provides semantic directed messaging, durable message history,
  summon-on-first-contact workflows, and live runtime utilities for HRC
  agent targets.

QUICK START
  Summon a dormant agent into the current project/lane:
  hrcchat summon cody@agentchat

  Prime a cold agent and print the immediate semantic reply:
  hrcchat dm cody@agentchat "Read the repo and prepare a review plan."

  Ask a worker to answer the human directly:
  hrcchat dm cody@agentchat "Summarize the current risks for the human." --respond-to human

  Wait quietly for a session target's final correlated run response:
  hrcchat dm cody@agentchat "Review this change." --wait response --timeout 20m

  Send literal input to a currently live runtime:
  hrcchat send cody@agentchat "continue from the last checkpoint" --enter

  Peek at current live work:
  hrcchat peek cody@agentchat --lines 120

  Query durable messages involving a target:
  hrcchat messages cody@agentchat --limit 50

  Follow monitor events for a target:
  hrc monitor watch cody@agentchat --follow --timeout 10m

  Wait for a response to a sent message:
  hrc monitor wait msg:msg_01J... --until response --timeout 15m

COMMAND NAMES (avoid phantom commands)
  Query durable history with 'messages' — there is no 'msg' or 'message'.
  Show one message with 'show <seq-or-id>' — there is no 'seq' command.
  Both CLIs suggest the right name (and exit non-zero) if you mistype.

SELECTORS
  'show' accepts a durable message seq number or a full message ID. The
  shared HRC selector grammar (scope:/session:/host:/runtime:/msg:/seq:/
  bare-handle) is documented in 'hrc info'; monitor waits accept it too,
  e.g. 'hrc monitor wait msg:<id> --until response'.

PROJECT RESOLUTION
  hrcchat resolves project context in this order:
  1. --project <id>
  2. ASP_PROJECT
  3. caller/target-derived project context when available

  Use --project when cwd inference is ambiguous or when targeting another
  project explicitly.

ENVIRONMENT VARIABLES
  HRC_SESSION_REF   Caller session identity used for "me" resolution
  ASP_PROJECT       Default project context for target resolution
  ASP_DEFAULT_TASK  Default task context after explicit target/caller defaults
  ASP_AGENTS_ROOT   Agents root used when resolving summon/dm runtime intent
`

/** Full `hrcchat info` text: curated prose + a COMMANDS roster generated from the live registry. */
export function buildInfoText(program: Command): string {
  return `${INFO_HEAD}
COMMANDS
${renderCommandRoster(program)}
`
}

export function cmdInfo(program: Command): void {
  process.stdout.write(buildInfoText(program))
}
