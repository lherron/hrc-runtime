import type { Command } from 'commander'

import { cmdMonitorShow } from '../monitor-show.js'
import { cmdMonitorWait } from '../monitor-wait.js'
import { cmdMonitorWatch } from '../monitor-watch.js'
import { toLegacyArgv } from './argv.js'
import { cmdSessionClearContext } from './handlers-control.js'
import {
  cmdServerRestart,
  cmdServerServe,
  cmdServerStart,
  cmdServerStatus,
  cmdServerStop,
  cmdSessionDropContinuation,
  cmdSessionGet,
  cmdSessionList,
  cmdSessionResolve,
  cmdTmuxKill,
  cmdTmuxStatus,
} from './handlers-server.js'
import { cmdSessionReport } from './runtime-select.js'
import { fatal } from './shared.js'

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
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), { strings: [], booleans: [] })
      await cmdServerServe(args)
    })

  server
    .command('stop')
    .description('stop the HRC daemon')
    .option('--timeout-ms <n>', 'shutdown timeout in milliseconds')
    .option('--force', 'force stop (skip in-flight check; SIGKILL if SIGTERM fails)')
    .option('--wait', 'wait for in-flight runs to drain before stopping')
    .option('--wait-timeout-ms <n>', 'max time to wait for in-flight drain (default 300000)')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['timeout-ms', 'wait-timeout-ms'],
        booleans: ['force', 'wait'],
      })
      await cmdServerStop(args)
    })

  server
    .command('restart')
    .description('restart the HRC daemon')
    .option('--timeout-ms <n>', 'timeout in milliseconds')
    .option('--force', 'force restart (skip in-flight check; SIGKILL if SIGTERM fails)')
    .option('--wait', 'wait for in-flight runs to drain before restarting')
    .option('--wait-timeout-ms <n>', 'max time to wait for in-flight drain (default 300000)')
    .option('--daemon', 'restart as background daemon')
    .option('--foreground', 'restart in foreground')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['timeout-ms', 'wait-timeout-ms'],
        booleans: ['force', 'wait', 'daemon', 'foreground'],
      })
      await cmdServerRestart(args)
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
    .description('kill the HRC tmux server and unclaimed broker-tmux leases')
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
    .command('clear-context')
    .description('clear session context')
    .argument('<hostSessionId>', 'host session ID')
    .option('--relaunch', 'relaunch after clearing')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: [],
        booleans: ['relaunch'],
      })
      await cmdSessionClearContext(args)
    })

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

  program
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

  // -- monitor group (docs/monitor-spec.md F2a) ----------------------------------

  const monitor = program
    .command('monitor')
    .description('show, watch, and wait on HRC monitor state')

  monitor
    .command('show')
    .description('show current HRC monitor snapshot')
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
    .description('wait for a monitor condition')
    .argument('[selector]', 'monitor selector')
    .option('--until <condition>', 'condition to wait for')
    .option('--timeout <duration>', 'maximum wait duration')
    .option('--stall-after <duration>', 'stall threshold duration')
    .option('--json', 'output structured JSON')
    .action(async (selector, _opts, cmd: Command) => {
      const positionals = selector !== undefined ? [selector] : []
      const args = toLegacyArgv(positionals, cmd.opts(), {
        strings: ['until', 'timeout', 'stall-after'],
        booleans: ['json'],
      })
      await cmdMonitorWait(args)
    })

  monitor
    .command('watch')
    .description('stream monitor events')
    .argument('[selector]', 'target selector')
    .option('--from-seq <n>', 'replay from sequence number')
    .option('--last <n>', 'replay the last n matching events')
    .option('--follow', 'stream live events after replay')
    .option('--until <condition>', 'exit when condition is met (requires --follow)')
    .option('--timeout <duration>', 'exit after duration without condition match')
    .option('--stall-after <duration>', 'exit after duration of inactivity')
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
    .action(async (selector, _opts, cmd: Command) => {
      const args = toLegacyArgv(selector ? [selector] : [], cmd.opts(), {
        strings: [
          'from-seq',
          'last',
          'until',
          'timeout',
          'stall-after',
          'format',
          'max-lines',
          'scope-width',
          'kind',
          'tool',
          'grep',
        ],
        booleans: ['follow', 'json', 'pretty', 'milestone'],
      })
      await cmdMonitorWatch(args)
    })
}
