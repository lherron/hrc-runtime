const INFO_TEXT = `hrcchat — semantic directed messaging for HRC agents

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

  Send literal input to a currently live runtime:
  hrcchat send cody@agentchat "continue from the last checkpoint" --enter

  Peek at current live work:
  hrcchat peek cody@agentchat --lines 120

  Query durable messages involving a target:
  hrcchat messages cody@agentchat --limit 50

  Follow monitor events for a target:
  hrc monitor watch cody@agentchat --follow --timeout 10m

  Wait for a response to a sent message:
  hrc monitor wait msg:msg_01J... --until response-or-idle --timeout 15m

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
  ASP_AGENTS_ROOT   Agents root used when resolving summon/dm runtime intent

COMMANDS
  info              Show this help
  who               List targets visible in the current project context
  summon            Materialize a target without starting a live runtime
  dm                Send a semantic directed request and capture any durable reply
  send              Deliver literal input to a currently live runtime
  show              Show one durable message by seq or message ID
  peek              Capture live output from a currently bound runtime
  messages          Query durable directed message history
  doctor            Run connectivity and target health checks
`

export function cmdInfo(): void {
  process.stdout.write(INFO_TEXT)
}

export { INFO_TEXT }
