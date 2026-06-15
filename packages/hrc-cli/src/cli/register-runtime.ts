import type { Command } from 'commander'

import { rawArgvForVerb, toLegacyArgv } from './argv.js'
import { cmdCapture, cmdInterrupt, cmdRuntimeEnsure, cmdTerminate } from './handlers-control.js'
import {
  cmdAdopt,
  cmdBrokerInspect,
  cmdLaunchList,
  cmdRuntimeInspect,
  cmdRuntimeList,
  cmdRuntimeSweep,
} from './handlers-runtime.js'

export function registerRuntimeCommands(program: Command): void {
  // -- runtime group (commander, Phase 6 T2) ----------------------------------

  const broker = program.command('broker').description('inspect broker-backed runtime invocations')

  broker
    .command('inspect')
    .description('inspect the broker read model (or HRC-derived fallback) for a runtime')
    .argument('<runtimeId>', 'runtime ID')
    .option('--probe', 'request a live liveness probe (capability-gated)')
    .option('--json', 'output as JSON')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: ['probe', 'json'],
      })
      await cmdBrokerInspect(args)
    })

  const runtime = program.command('runtime').description('ensure, inspect, and control runtimes')

  runtime
    .command('ensure', { hidden: true })
    .description('ensure a runtime (low-level; hidden from operator help, used by API clients)')
    .argument('<hostSessionId>', 'host session ID')
    .option('--provider <provider>', 'provider (anthropic|openai)')
    .option('--restart-style <style>', 'restart style (reuse_pty|fresh_pty)')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: ['provider', 'restart-style'],
        booleans: [],
      })
      await cmdRuntimeEnsure(args)
    })

  runtime
    .command('list')
    .description('list runtimes')
    .option('--host-session-id <id>', 'filter by host session')
    .option('--transport <transport>', 'filter by transport (tmux|headless|sdk)')
    .option('--status <status>', 'filter by status')
    .option('--older-than <duration>', 'filter by age')
    .option('--scope <scope>', 'filter by scope')
    .option('--json', 'output as JSON')
    .option('--stale', 'show only stale runtimes')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['host-session-id', 'transport', 'status', 'older-than', 'scope'],
        booleans: ['json', 'stale'],
      })
      await cmdRuntimeList(args)
    })

  runtime
    .command('inspect')
    .description('inspect a runtime')
    .argument('<runtimeId>', 'runtime ID')
    .option('--json', 'output as JSON')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdRuntimeInspect(args)
    })

  runtime
    .command('sweep')
    .description('sweep stale runtimes')
    .option('--transport <transport>', 'filter by transport (tmux|headless|sdk)')
    .option('--status <status>', 'filter by status')
    .option('--scope <scope>', 'filter by scope')
    .option('--older-than <duration>', 'filter by age')
    .option('--dry-run', 'preview without mutating')
    .option('--yes', 'confirm mutation')
    .option('--json', 'output as JSON')
    .option('--drop-continuation', 'drop continuation on sweep')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['transport', 'status', 'scope', 'older-than'],
        booleans: ['dry-run', 'yes', 'json', 'drop-continuation'],
      })
      await cmdRuntimeSweep(args)
    })

  runtime
    .command('capture')
    .description('capture live runtime output')
    .argument('<runtimeId>', 'runtime ID')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdCapture(args)
    })

  runtime
    .command('interrupt')
    .description('interrupt a runtime')
    .argument('<runtimeId>', 'runtime ID')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdInterrupt(args)
    })

  runtime
    .command('terminate')
    .description('terminate a runtime')
    .argument('<runtimeId>', 'runtime ID')
    .option('--drop-continuation', 'drop continuation on terminate')
    .option('--no-drop-continuation', 'explicitly preserve continuation')
    .option('--reason <reason>', 'operator intent stamped on the runtime.terminated audit event')
    .option('--source <source>', 'tool/source that initiated the terminate')
    .action(async (runtimeId, _opts, cmd: Command) => {
      // Scope the negated-flag scan to the active command path's raw argv,
      // not the full process.argv, to avoid surprise matches from globals.
      const rawArgv = rawArgvForVerb(cmd, 'terminate')
      const args = toLegacyArgv(
        [runtimeId],
        cmd.opts(),
        {
          strings: ['reason', 'source'],
          booleans: [],
          negatedBooleans: ['drop-continuation'],
        },
        rawArgv
      )
      await cmdTerminate(args)
    })

  runtime
    .command('adopt')
    .description('adopt a dead/stale runtime')
    .argument('<runtimeId>', 'runtime ID')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdAdopt(args)
    })

  // -- launch group (commander, Phase 6 T2) -----------------------------------

  const launch = program.command('launch').description('list launches')

  launch
    .command('list')
    .description('list launches')
    .option('--host-session-id <id>', 'filter by host session')
    .option('--runtime-id <id>', 'filter by runtime')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['host-session-id', 'runtime-id'],
        booleans: [],
      })
      await cmdLaunchList(args)
    })
}
