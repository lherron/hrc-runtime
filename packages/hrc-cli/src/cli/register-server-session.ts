import type { Command } from 'commander'

import { VALID_CONDITIONS } from '../monitor-conditions.js'
import { cmdMonitorShow } from '../monitor-show.js'
import { cmdMonitorWait } from '../monitor-wait.js'
import { cmdMonitorWatch } from '../monitor-watch.js'
import { toLegacyArgv } from './argv.js'
import { type CommandMetadataInput, annotateCommand } from './command-metadata.js'
import { cmdSessionClearContext } from './handlers-control.js'
import {
  cmdServerRestart,
  cmdServerServe,
  cmdServerStart,
  cmdServerStatus,
  cmdServerStop,
  cmdServerSubscribers,
  cmdSessionDropContinuation,
  cmdSessionGet,
  cmdSessionList,
  cmdSessionResolve,
  cmdTmuxKill,
  cmdTmuxStatus,
} from './handlers-server.js'
import { registerMovedCommandShim } from './moved-command.js'
import { cmdSessionReport } from './runtime-select.js'
import { fatal } from './shared.js'

const MONITOR_CONDITIONS_HELP = [...VALID_CONDITIONS].join(', ')
const MONITOR_EXIT_CODES_HELP =
  'Exit codes: 0 matched after arm/replay (outcome=success); 10 already true at arm (outcome=success); 2 usage (no terminal event); 11 no session ever (outcome=not_matched); 12 runtime-death obstruction (outcome=not_matched); 13 observed terminal failure (outcome=observed_failure); 20 timeout (outcome=not_matched); 21 stall (outcome=not_matched); 22 context change (outcome=not_matched); 23 monitor error (outcome=error); 130 SIGINT (outcome=error).'
const MONITOR_AGENT_EXIT_CODES =
  '0 matched (success); 10 already true at arm (success); 2 usage/no event; 11 no session ever (not_matched); 12 runtime death obstruction (not_matched); 13 terminal failure (observed_failure); 20 timeout (not_matched); 21 stall (not_matched); 22 context change (not_matched); 23 monitor error (error); 130 SIGINT (error)'

function collectMonitorCondition(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function annotateChild(parent: Command, name: string, metadata: CommandMetadataInput): void {
  const command = parent.commands.find((candidate) => candidate.name() === name)
  if (!command) throw new Error(`missing registered command ${parent.name()} ${name}`)
  annotateCommand(command, metadata)
}

export function registerServerSessionCommands(program: Command): void {
  // -- server group (commander, Phase 6 T1) -----------------------------------

  const server = program
    .command('server')
    .description('daemon lifecycle, health, and tmux backend control')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (_opts, cmd: Command) => {
      if (cmd.args.length > 0) {
        fatal(`unknown command: server ${cmd.args[0]}`)
      }
      // No-verb fallthrough: bare `hrc server` starts in foreground
      // (preserves legacy behavior where `hrc server [flags]` delegates to start)
      await cmdServerStart(cmd.args, 'foreground')
    })

  server
    .command('start')
    .description('start the HRC server')
    .option('--timeout-ms <n>', 'startup timeout in milliseconds')
    .option('--daemon', 'run as background daemon')
    .option('--foreground', 'run in foreground (default)')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['timeout-ms'],
        booleans: ['daemon', 'foreground'],
      })
      await cmdServerStart(args, 'foreground')
    })

  server
    .command('serve')
    .description('run the server in the foreground for supervisors')
    .option(
      '--allow-persona <agentIds...>',
      'allow only these agent personas to execute locally (omitted means unrestricted)'
    )
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['allow-persona'],
        booleans: [],
      })
      await cmdServerServe(args)
    })

  server
    .command('stop')
    .description('stop the HRC daemon')
    .option('--timeout-ms <n>', 'shutdown timeout in milliseconds')
    .option('--reason <text>', 'operator reason (required from a primary-scoped runtime)')
    .option('--force', 'force stop (skip in-flight check; SIGKILL if SIGTERM fails)')
    .option('--wait', 'wait for in-flight runs to drain before stopping')
    .option('--wait-timeout-ms <n>', 'max time to wait for in-flight drain (default 300000)')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['timeout-ms', 'wait-timeout-ms', 'reason'],
        booleans: ['force', 'wait'],
      })
      await cmdServerStop(args)
    })

  server
    .command('restart')
    .description('restart the HRC daemon')
    .option('--timeout-ms <n>', 'timeout in milliseconds')
    .option('--reason <text>', 'operator reason (required from a primary-scoped runtime)')
    .option('--force', 'force restart (skip in-flight check; SIGKILL if SIGTERM fails)')
    .option('--wait', 'drain in-flight runs, then prove a healthy new daemon process answers')
    .option('--wait-timeout-ms <n>', 'max time to wait for in-flight drain (default 300000)')
    .option('--drain', 'close daemon turn admission, drain, recheck, and restart')
    .option(
      '--drain-timeout-ms <n>',
      'max closed-admission drain time before explicit force fallback (default 300000)'
    )
    .option('--daemon', 'restart as background daemon')
    .option('--foreground', 'restart in foreground')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['timeout-ms', 'wait-timeout-ms', 'drain-timeout-ms', 'reason'],
        booleans: ['force', 'wait', 'drain', 'daemon', 'foreground'],
      })
      await cmdServerRestart(args)
    })

  server
    .command('subscribers')
    .description('show follow-stream admission and consumer-receipt accounting')
    .option('--json', 'output as JSON')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdServerSubscribers(args)
    })

  server
    .command('status')
    .description('show daemon/socket/API health state')
    .option('--json', 'output as JSON')
    .addHelpText(
      'after',
      `
Exit codes:
  0  healthy: daemon socket responds and API health passes
  1  not running: no live daemon process or socket
  2  usage error, or degraded/stale daemon state
  3  local status probe failed
`
    )
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdServerStatus(args)
    })

  const serverTmux = server.command('tmux').description('tmux and broker-tmux backend control')

  serverTmux
    .command('status')
    .description('show tmux socket/session state')
    .option('--json', 'output as JSON')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdTmuxStatus(args)
    })

  serverTmux
    .command('kill')
    .description('kill the HRC tmux server and broker-tmux leases, claimed orphans included')
    .option('--yes', 'confirm destructive operation')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: [],
        booleans: ['yes'],
      })
      await cmdTmuxKill(args)
    })

  // -- session group (commander, Phase 6 T2) ---------------------------------

  const session = program.command('session').description('resolve, list, and inspect sessions')

  session
    .command('resolve')
    .description('resolve a session')
    .option('--scope <scope>', 'scope reference')
    .option('--lane <lane>', 'lane reference')
    .option('--create', 'create a session if none exists')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['scope', 'lane'],
        booleans: ['create'],
      })
      await cmdSessionResolve(args)
    })

  session
    .command('list')
    .description('list sessions')
    .option('--scope <scope>', 'scope reference')
    .option('--lane <lane>', 'lane reference')
    .option('--all', 'include archived sessions and drop the recency window')
    .option('--dormant', 'include dormant resumable archived session heads')
    .option('--since <duration>', 'recency window for active heads (e.g. 12h, 7d)')
    .option('--gens', 'expand rotated generations instead of collapsing them')
    .option('--by-project', 'group rows by project instead of agent')
    .option('--json', 'force JSON output')
    .option('--porcelain', 'stable tab-separated output for scripts')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['scope', 'lane', 'since'],
        booleans: ['all', 'dormant', 'gens', 'by-project', 'json', 'porcelain'],
      })
      await cmdSessionList(args)
    })

  session
    .command('get')
    .description('get a session by ID')
    .argument('<hostSessionId>', 'host session ID')
    .option('--live', 'join backing runtime(s) and attach broker/HRC-derived inspection')
    .option('--probe', 'with --live, request a live liveness probe (capability-gated)')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: [],
        booleans: ['live', 'probe'],
      })
      await cmdSessionGet(args)
    })

  session
    .command('rotate')
    .description(
      'archive the active host session and create generation+1, copying continuation forward'
    )
    .argument('<hostSessionId>', 'host session ID')
    .option('--relaunch', 'relaunch after rotating')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: [],
        booleans: ['relaunch'],
      })
      await cmdSessionClearContext(args)
    })

  registerMovedCommandShim(session, 'clear-context', 'hrc session rotate')

  session
    .command('drop-continuation')
    .description('drop stored continuation')
    .argument('<hostSessionId>', 'host session ID')
    .option('--reason <reason>', 'reason for dropping')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: ['reason'],
        booleans: [],
      })
      await cmdSessionDropContinuation(args)
    })

  // -- monitor group (docs/monitor-spec.md F2a) ----------------------------------

  const monitor = program
    .command('monitor')
    .description('show, watch, and wait on HRC monitor state')

  monitor
    .command('session-report')
    .description(
      "render a runtime's broker session summary, optionally holding for a keypress (viewer windows)"
    )
    .option('--runtime <runtimeId>', 'runtime ID')
    .option('--scope <scope>', 'scope label for the report header')
    .option('--wait-key', 'wait for a keypress before returning (viewer windows)')
    .option(
      '--wait-timeout <seconds>',
      'bound --wait-key to N seconds, then auto-close (consolidated viewer panes; T-05237)'
    )
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['runtime', 'scope', 'wait-timeout'],
        booleans: ['wait-key'],
      })
      await cmdSessionReport(args)
    })

  registerMovedCommandShim(program, 'session-report', 'hrc monitor session-report')

  monitor
    .command('show')
    .description(
      'show the current monitor-state snapshot and counters, unlike hrc ls or hrc runtime list inventory'
    )
    .argument('[selector]', 'monitor selector')
    .option('--json', 'output structured JSON')
    .action(async (selector, _opts, cmd: Command) => {
      const positionals = selector !== undefined ? [selector] : []
      const args = toLegacyArgv(positionals, cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdMonitorShow(args)
    })

  monitor
    .command('wait')
    .description('watch --until without the event stream, using the same condition engine')
    .argument('[selectors...]', 'one or more exact, scope-prefix, or task-id selectors')
    .option(
      '--until <condition>',
      `exact selector condition (repeat for OR): ${MONITOR_CONDITIONS_HELP}`,
      collectMonitorCondition,
      []
    )
    .option(
      '--until-any <condition>',
      `set condition; first matching member wins (repeat for OR): ${MONITOR_CONDITIONS_HELP}`,
      collectMonitorCondition,
      []
    )
    .option(
      '--until-all <condition>',
      'set condition; every frozen member must match (repeat for OR; levels only)',
      collectMonitorCondition,
      []
    )
    .option('--timeout <duration>', 'maximum wait duration')
    .option('--stall-after <duration>', 'stall threshold duration')
    .option(
      '--since <seq|duration>',
      'terminal evidence fence; exact cursors are safest for scripts, durations are a human convenience'
    )
    .option('--json', 'output structured JSON')
    .addHelpText(
      'after',
      `\nTask, prefix, and multiple-selector waits require --until-any or --until-all. --until-all accepts levels only and freezes membership at arm.\n${MONITOR_EXIT_CODES_HELP}\n`
    )
    .action(async (selectors: string[], _opts, cmd: Command) => {
      const positionals = selectors ?? []
      const args = toLegacyArgv(positionals, cmd.opts(), {
        strings: ['until', 'until-any', 'until-all', 'timeout', 'stall-after', 'since'],
        booleans: ['json'],
      })
      await cmdMonitorWait(args)
    })

  monitor
    .command('watch')
    .description('stream monitor events')
    .argument('[selectors...]', 'exact selectors, scope:<prefix>:*, or a bare T-XXXXX')
    .option('--from-seq <n>', 'replay from sequence number')
    .option('--last <n>', 'replay the last n matching events')
    .option('--follow', 'stream live events after replay')
    .option(
      '--forever',
      'keep a follow watch open instead of using the default turn-finished/runtime-dead pair'
    )
    .option(
      '--until <condition>',
      `exact selector condition (repeat for OR): ${MONITOR_CONDITIONS_HELP}`,
      collectMonitorCondition,
      []
    )
    .option(
      '--until-any <condition>',
      `set condition; first matching member wins (repeat for OR): ${MONITOR_CONDITIONS_HELP}`,
      collectMonitorCondition,
      []
    )
    .option(
      '--until-all <condition>',
      'set condition; every frozen member must match (repeat for OR; levels only)',
      collectMonitorCondition,
      []
    )
    .option('--timeout <duration>', 'exit after duration without condition match')
    .option('--stall-after <duration>', 'exit after duration of inactivity')
    .option(
      '--since <seq|duration>',
      'terminal evidence fence; exact cursors are safest for scripts, durations are a human convenience'
    )
    .option('--json', 'output JSON lines')
    .option(
      '--format <mode>',
      'output mode: tree, compact, verbose, json, ndjson, invocation-events'
    )
    .option('--pretty', 'alias for --format=tree')
    .option('--max-lines <n>', 'tree mode: truncate body blocks to n lines')
    .option('--scope-width <n>', 'tree mode: per-row scope badge width in chars')
    .option('--kind <kinds>', 'filter to comma-separated event_kind list')
    .option('--tool <names>', 'filter to turn.tool_call events for comma-separated toolName list')
    .option('--grep <substr>', 'filter to events whose payload contains the substring')
    .option('--milestone', 'curated preset: turn/runtime lifecycle + operator tool calls')
    .option(
      '--all-events',
      'disable the milestone default for multi/prefix/task-id selectors (raw firehose)'
    )
    .addHelpText(
      'after',
      `\nBlocking watches default to --until turn-finished --until runtime-dead. Fan-in selectors require --until-any or --until-all; --kind/--tool/--grep or --all-events controls event filtering.
Default replay is capped at 100 events; use --last N or --from-seq N to retrieve more.
response is legal only with exactly one msg: or seq: selector under --until.
--until-all accepts level conditions only: idle, busy, runtime-dead.
--stall-after exits the stream (it is not a pause signal).
Default output format is tree when stdout is a TTY and ndjson when stdout is not a TTY.
${MONITOR_EXIT_CODES_HELP}\n`
    )
    .action(async (selectors: string[], _opts, cmd: Command) => {
      const args = toLegacyArgv(selectors ?? [], cmd.opts(), {
        strings: [
          'from-seq',
          'last',
          'until',
          'until-any',
          'until-all',
          'timeout',
          'stall-after',
          'since',
          'format',
          'max-lines',
          'scope-width',
          'kind',
          'tool',
          'grep',
        ],
        booleans: ['follow', 'json', 'pretty', 'milestone', 'forever', 'all-events'],
      })
      await cmdMonitorWatch(args)
    })

  annotateCommand(server, { audience: 'human' })
  annotateCommand(session, { audience: 'human' })
  annotateCommand(monitor, { audience: 'human' })
  annotateChild(server, 'status', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc server status --json',
      exitCodes: '0 healthy; 1 not running; 2 degraded/usage; 3 probe failure',
      output: '--json emits one status document; human output is for terminals',
    },
  })
  annotateChild(session, 'list', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc session list --scope cody@hrc-runtime:T-07011 --json',
      exitCodes: '0 success; 2 usage; 1 read failure',
      output: '--json is one array; --porcelain is stable tab-separated output',
    },
  })
  annotateChild(monitor, 'show', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc monitor show T-07011 --json',
      exitCodes: '0 snapshot read; 2 usage; 23 daemon/read failure',
      output: '--json is one snapshot document keyed by global hrcSeq',
    },
  })
  annotateChild(monitor, 'watch', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc monitor watch T-07011 --follow --format ndjson',
      exitCodes: MONITOR_AGENT_EXIT_CODES,
      output: 'non-TTY defaults to NDJSON; each line is one complete normalized HRC event',
    },
  })
  annotateChild(monitor, 'wait', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc monitor wait T-07011 --until-all runtime-dead --timeout 5m --json',
      exitCodes: MONITOR_AGENT_EXIT_CODES,
      output: '--json emits one condition result; timeout is semantic exit 20, not command failure',
    },
  })
}
