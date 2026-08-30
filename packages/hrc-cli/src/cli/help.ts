import { CliUsageError } from 'cli-kit'
import type { Command } from 'commander'

import { resolveServerPaths } from '../cli-runtime.js'
import { renderServerStatusJsonContract } from '../cli-runtime/server-status-contract.js'
import {
  type HrcCommandMetadata,
  allCommandNodes,
  audienceIncludes,
  commandMetadata,
  commandPath,
} from './command-metadata.js'

export type HelpView = 'agent' | 'human'

type ViewFlags = {
  agent?: boolean | undefined
  human?: boolean | undefined
}

type ViewContext = {
  env?: Record<string, string | undefined> | undefined
  isTTY?: boolean | undefined
}

function hasAgentIdentity(env: Record<string, string | undefined>): boolean {
  return ['ASP_AGENT_ID', 'AGENT_ID', 'HRC_SESSION_REF'].some((name) => env[name]?.trim().length)
}

/** Selection precedence: explicit flag > agent identity environment > stdout TTY. */
export function resolveHelpView(flags: ViewFlags = {}, context: ViewContext = {}): HelpView {
  if (flags.agent && flags.human) {
    throw new CliUsageError('--agent and --human are mutually exclusive')
  }
  if (flags.agent) return 'agent'
  if (flags.human) return 'human'
  const env = context.env ?? process.env
  if (hasAgentIdentity(env)) return 'agent'
  return (context.isTTY ?? process.stdout.isTTY === true) ? 'human' : 'agent'
}

function isVisible(command: Command): boolean {
  const parent = command.parent
  return parent ? parent.createHelp().visibleCommands(parent).includes(command) : true
}

function padRows(rows: Array<{ name: string; summary: string }>): string {
  if (rows.length === 0) return '  (none)'
  const width = Math.max(...rows.map((row) => row.name.length))
  return rows.map((row) => `  ${row.name.padEnd(width + 2)}${row.summary}`).join('\n')
}

function viewNotice(view: HelpView): string {
  const other = view === 'agent' ? 'human' : 'agent'
  return [
    `VIEW: ${view}`,
    `  Override with --${other}. The complete maintenance cellar is always visible via:`,
    '  hrc admin --help',
  ].join('\n')
}

function agentCommands(
  program: Command
): Array<{ command: Command; metadata: HrcCommandMetadata }> {
  return allCommandNodes(program)
    .slice(1)
    .filter(isVisible)
    .map((command) => ({ command, metadata: commandMetadata(command) }))
    .filter(
      ({ metadata }) => audienceIncludes(metadata, 'agent') && metadata.agentUsage !== undefined
    )
}

function humanTopLevel(program: Command): Command[] {
  return program.commands.filter(
    (command) => isVisible(command) && audienceIncludes(commandMetadata(command), 'human')
  )
}

function renderAgentRoster(program: Command): string {
  return padRows(
    agentCommands(program).map(({ command, metadata }) => ({
      name: commandPath(command),
      summary: metadata.humanSummary,
    }))
  )
}

function renderHumanSections(program: Command): string {
  const top = humanTopLevel(program)
  const flows = top.filter((command) => commandMetadata(command).humanExample !== undefined)
  const groups = top.filter(
    (command) =>
      command.commands.some(isVisible) && commandMetadata(command).humanExample === undefined
  )
  const commands = top.filter(
    (command) =>
      !command.commands.some(isVisible) && commandMetadata(command).humanExample === undefined
  )
  return [
    'GROUPS',
    padRows(
      groups.map((command) => ({
        name: command.name(),
        summary: commandMetadata(command).humanSummary,
      }))
    ),
    '',
    'HUMAN FLOWS',
    ...flows.map((command) => {
      const metadata = commandMetadata(command)
      return `  ${metadata.humanExample}\n    ${metadata.humanSummary}`
    }),
    '',
    'OTHER COMMANDS',
    padRows(
      commands.map((command) => ({
        name: command.name(),
        summary: commandMetadata(command).humanSummary,
      }))
    ),
  ].join('\n')
}

export function renderRootHelp(program: Command, view?: HelpView): string {
  const selected = view ?? resolveHelpView(program.opts<ViewFlags>())
  const body =
    selected === 'agent'
      ? `AGENT COMMANDS\n${renderAgentRoster(program)}`
      : renderHumanSections(program)
  return `Usage: hrc [--agent|--human] <command> [options]

${viewNotice(selected)}

${body}

Run hrc <command> --help for the complete help of any explicitly named command.
`
}

async function resolveNodeIdentitySummary(): Promise<{
  nodeId: string
  nodeIdProvenance: string
  mode: string
  configPath: string
  configExists: boolean
  peerCount: number
  error?: string
}> {
  const { resolveFederationConfig, summarizeFederationConfig, resolveFederationConfigPath } =
    await import('hrc-server')
  const { stateRoot } = resolveServerPaths()
  try {
    return summarizeFederationConfig(await resolveFederationConfig({ stateRoot }))
  } catch (error) {
    return {
      nodeId: '(unresolved)',
      nodeIdProvenance: 'unresolved',
      mode: 'unresolved',
      configPath: resolveFederationConfigPath(stateRoot),
      configExists: true,
      peerCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

type NodeSummary = Awaited<ReturnType<typeof resolveNodeIdentitySummary>>

function renderNode(node: NodeSummary | undefined): string {
  if (!node) return ''
  const lines = [
    '',
    'THIS NODE',
    `  nodeId: ${node.nodeId} (${node.nodeIdProvenance})`,
    `  mode:   ${node.mode}`,
    `  peers:  ${node.peerCount}`,
  ]
  if (node.error) lines.push(`  error:  ${node.error}`)
  return lines.join('\n')
}

function renderAgentInfo(program: Command): string {
  const blocks = agentCommands(program).map(({ command, metadata }) => {
    const usage = metadata.agentUsage
    if (!usage) return ''
    return [
      `  hrc ${commandPath(command)}`,
      `    ${metadata.humanSummary}`,
      `    Example: ${usage.example}`,
      `    Exit:    ${usage.exitCodes}`,
      `    Output:  ${usage.output}`,
    ].join('\n')
  })
  return `SELECTORS
  runtime:<id> | host:<id> | session:<ref> | scope:<ref> | msg:<id> | seq:<n> | <target-handle>
  Raw native IDs win first; explicit prefixes win by type; ambiguous bare selectors fail closed.

OUTPUT
  JSON is one complete document. NDJSON is one complete object per line.
  Never parse terminal-oriented human/tree output in automation.

${renderServerStatusJsonContract()}

CURSORS
  monitor show/watch/wait use global hrcSeq replay and condition fences.
  monitor events/transcript/stats use invocation-local broker seq. The grammars are distinct.
  Monitor conditions NEVER evaluate the broker invocation ledger.

PLACEMENT
  hrc start/resume --cwd <absolute-path> changes execution cwd without changing project root.

RUNBOOK
${blocks.join('\n\n')}`
}

function renderHumanInfo(program: Command): string {
  return `ABOUT
  HRC is the local runtime control plane for agent targets, continuity sessions, and live runtimes.
  Use hrc to inspect or control runtime state (execution); use wrkc to talk to agents
  (collaboration). Only 'wrkc say --to' fires — a say without it is a room log entry.

${renderHumanSections(program)}

MODEL
  target = who you mean; session = continuity; runtime = the live execution.
  Start/reuse/attach with hrc run. Attach without launching with hrc attach.
  Resume is continuation-only recovery: it never fresh-launches and is not an alias of run.
  hrc start/resume --cwd <absolute-path> changes execution cwd without changing project root.`
}

export function buildInfoText(
  program: Command,
  node?: NodeSummary,
  view: HelpView = resolveHelpView()
): string {
  return `hrc — HRC ${view === 'agent' ? 'agent runbook' : 'operator guide'}

${viewNotice(view)}

${view === 'agent' ? renderAgentInfo(program) : renderHumanInfo(program)}
${renderNode(node)}

Run hrc <command> --help for complete command-specific flags and edge cases.
`
}

export async function printInfo(
  program: Command,
  options: ViewFlags & { json?: boolean | undefined } = {}
): Promise<void> {
  const view = resolveHelpView(options)
  const node = await resolveNodeIdentitySummary()
  const text = buildInfoText(program, node, view)
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ command: 'hrc', view, text, node }, null, 2)}\n`)
    return
  }
  process.stdout.write(text)
}
