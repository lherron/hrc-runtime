import type { Command } from 'commander'

import { cmdBrokerEvents, cmdBrokerStats, cmdBrokerTranscript } from '../broker-forensics.js'
import { cmdBrokerVerifyCandidates, cmdBrokerVerifyRun } from '../broker-verify/commands.js'
import { cmdEventsDrain } from '../events-drain.js'
import { rawArgvForVerb, toLegacyArgv } from './argv.js'
import { type CommandMetadataInput, annotateCommand } from './command-metadata.js'
import {
  cmdCapture,
  cmdInflightSend,
  cmdInterrupt,
  cmdRuntimeEnsure,
  cmdTerminate,
} from './handlers-control.js'
import { cmdRegistrationsGc } from './handlers-registration-gc.js'
import {
  cmdAdopt,
  cmdRuntimeDiagnostics,
  cmdRuntimeInspect,
  cmdRuntimeList,
  cmdRuntimePrune,
  cmdRuntimeStatus,
  cmdRuntimeSweep,
} from './handlers-runtime.js'
import { registerMovedCommandShim, throwMovedCommand } from './moved-command.js'

function requireGroup(parent: Command, name: string): Command {
  const group = parent.commands.find((command) => command.name() === name)
  if (!group) throw new Error(`hrc command registration order error: missing ${name}`)
  return group
}

function annotateChild(parent: Command, name: string, metadata: CommandMetadataInput): void {
  const command = requireGroup(parent, name)
  annotateCommand(command, metadata)
}

function registerBrokerReads(monitor: Command): void {
  monitor
    .command('events')
    .description(
      'list durable invocation-ledger events (invocation-local seq; never used by monitor conditions)'
    )
    .argument('[target]', 'runtime ID, invocation ID, scope ref, or target handle')
    .option('--source-ref <ref>', 'select imported rows by exact source_ref')
    .option('--type <types>', 'comma-separated event types')
    .option('--seq <range>', 'inclusive invocation-local sequence range (<from>..<to>)')
    .option('--latest', 'select the newest runtime when a scope is ambiguous')
    .option('--previous [n]', 'select the nth-most-recent terminated runtime for a scope')
    .option('--json', 'output as a JSON array')
    .option('--ndjson', 'output one complete event per NDJSON line')
    .option('--provenance', 'show sourceKind/nativeType/rawRecordId in table output')
    .addHelpText(
      'after',
      '\nThis reads the durable broker invocation ledger. Monitor conditions NEVER evaluate that ledger; hrcSeq replay/fences belong to monitor show/watch/wait and use a different cursor grammar.\n'
    )
    .action(async (target, _opts, cmd: Command) => {
      await cmdBrokerEvents(
        toLegacyArgv(target ? [target] : [], cmd.opts(), {
          strings: ['type', 'seq', 'source-ref', 'previous'],
          booleans: ['latest', 'json', 'ndjson', 'provenance'],
        })
      )
    })

  monitor
    .command('transcript')
    .description(
      'render an invocation activity transcript (tool starts/results, completed assistant messages, driver notices)'
    )
    .argument('[target]', 'runtime ID, invocation ID, scope ref, or target handle')
    .option('--source-ref <ref>', 'select imported rows by exact source_ref')
    .option('--seq <range>', 'inclusive invocation-local sequence range (<from>..<to>)')
    .option('--kinds <kinds>', 'comma-separated user,exec,cot,notice kinds', 'user,exec,cot,notice')
    .option('--tail <n>', 'emit only the last n rendered events')
    .option('--full', 'do not clip long event text')
    .option('--latest', 'select the newest runtime when a scope is ambiguous')
    .option('--previous [n]', 'select the nth-most-recent terminated runtime for a scope')
    .addHelpText(
      'after',
      '\nThis is invocation activity, not conversation readback. Its --seq cursor is invocation-local and is not an hrcSeq monitor replay cursor.\n'
    )
    .action(async (target, _opts, cmd: Command) => {
      await cmdBrokerTranscript(
        toLegacyArgv(target ? [target] : [], cmd.opts(), {
          strings: ['seq', 'kinds', 'source-ref', 'tail', 'previous'],
          booleans: ['full', 'latest'],
        })
      )
    })

  monitor
    .command('stats')
    .description('summarize durable invocation-ledger activity')
    .argument('[target]', 'runtime ID, invocation ID, scope ref, or target handle')
    .option('--source-ref <ref>', 'select imported rows by exact source_ref')
    .option('--latest', 'select the newest runtime when a scope is ambiguous')
    .option('--previous [n]', 'select the nth-most-recent terminated runtime for a scope')
    .option('--json', 'output as JSON')
    .addHelpText(
      'after',
      '\nThis summarizes the durable broker invocation ledger. Monitor conditions NEVER evaluate that ledger.\n'
    )
    .action(async (target, _opts, cmd: Command) => {
      await cmdBrokerStats(
        toLegacyArgv(target ? [target] : [], cmd.opts(), {
          strings: ['source-ref', 'previous'],
          booleans: ['latest', 'json'],
        })
      )
    })
}

function registerAdminRuntimeCommands(admin: Command): void {
  const adminRuntime = admin
    .command('runtime')
    .description('low-level runtime provisioning and adoption')

  adminRuntime
    .command('ensure')
    .description('ensure a runtime exists for a host session')
    .argument('<hostSessionId>', 'host session ID')
    .option('--provider <provider>', 'provider (anthropic|openai)')
    .option('--restart-style <style>', 'restart style (reuse_pty|fresh_pty)')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      await cmdRuntimeEnsure(
        toLegacyArgv([hostSessionId], cmd.opts(), {
          strings: ['provider', 'restart-style'],
          booleans: [],
        })
      )
    })

  adminRuntime
    .command('adopt')
    .description('adopt a dead or stale runtime')
    .argument('<runtimeId>', 'runtime ID')
    .action(async (runtimeId) => {
      await cmdAdopt([runtimeId])
    })

  adminRuntime
    .command('prune')
    .description('prune an exact allowlisted runtime manifest, including durable ledgers')
    .requiredOption('--runtime-ids-file <file>', 'newline-delimited exact runtime IDs')
    .requiredOption('--include-ledgers', 'delete keep-forever ledgers and broker projections')
    .option('--dry-run', 'preview per-table delete counts without deleting')
    .requiredOption('--yes', 'confirm the destructive manifest operation')
    .option('--json', 'output as JSON')
    .action(async (_opts, cmd: Command) => {
      await cmdRuntimePrune(
        toLegacyArgv([], cmd.opts(), {
          strings: ['runtime-ids-file'],
          booleans: ['include-ledgers', 'dry-run', 'yes', 'json'],
        })
      )
    })
}

function registerAdminBrokerVerify(admin: Command): void {
  const verify = admin.command('broker-verify').description('verify broker capture and projection')

  verify
    .command('candidates')
    .description('list broker invocation verification candidates for an exact scope ref')
    .argument('<scope-ref>', 'exact scope_ref')
    .option('--json', 'output as JSON')
    .action(async (scopeRef, _opts, cmd: Command) => {
      await cmdBrokerVerifyCandidates(
        toLegacyArgv([scopeRef], cmd.opts(), { strings: [], booleans: ['json'] })
      )
    })

  verify
    .command('run')
    .description(
      'verify one broker invocation against its ledger, raw mirror, and optional provider JSONL'
    )
    .requiredOption('--invocation <id>', 'broker invocation id')
    .option('--jsonl <path>', 'provider transcript JSONL path')
    .option('--strict-text', 'fail assistant text mismatches instead of warning')
    .option('--json', 'output as JSON')
    .action(async (_opts, cmd: Command) => {
      await cmdBrokerVerifyRun(
        toLegacyArgv([], cmd.opts(), {
          strings: ['invocation', 'jsonl'],
          booleans: ['strict-text', 'json'],
        })
      )
    })
}

function registerAdminEvents(admin: Command): void {
  admin
    .command('events')
    .description('recover HRC event ledgers')
    .command('drain')
    .description("push a dead container ledger's unforwarded tails into host HRC")
    .argument('<state.sqlite>', 'path to the dead container HRC state database')
    .requiredOption('--source-ref <ref>', 'exact claimed source_ref for attribution and dedup')
    .option('--json', 'output as JSON')
    .action(async (dbPath, _opts, cmd: Command) => {
      const opts = cmd.opts<{ sourceRef: string; json?: boolean }>()
      await cmdEventsDrain({
        dbPath,
        sourceRef: opts.sourceRef,
        ...(opts.json ? { json: true } : {}),
      })
    })
}

function registerAdminRegistrations(admin: Command): void {
  const registrations = admin
    .command('registrations')
    .description('inspect and retire externally registered instance scopes')

  registrations
    .command('gc')
    .description('list retirement candidates, or retire explicitly selected candidate scopes')
    .argument('[scope...]', 'exact candidate instance scope(s) to retire')
    .option('--yes', 'confirm retirement without an interactive prompt')
    .option('--json', 'output as JSON')
    .action(async (scopeRefs: string[] | undefined, _opts, cmd: Command) => {
      await cmdRegistrationsGc(
        toLegacyArgv(scopeRefs ?? [], cmd.opts(), {
          strings: [],
          booleans: ['yes', 'json'],
        })
      )
    })
}

function registerLegacyBrokerShim(program: Command): void {
  const broker = program
    .command('broker', { hidden: true })
    .description('moved under monitor, runtime, and admin')
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')

  broker.action((args: string[] | undefined) => {
    const verb = args?.[0]
    const replacement =
      verb === 'inspect'
        ? 'hrc runtime inspect'
        : verb === 'verify'
          ? 'hrc admin broker-verify'
          : verb === 'events' || verb === 'transcript' || verb === 'stats'
            ? `hrc monitor ${verb}`
            : 'hrc monitor events|transcript|stats, hrc runtime inspect, or hrc admin broker-verify'
    throwMovedCommand(`broker${verb ? ` ${verb}` : ''}`, replacement)
  })
}

export function registerRuntimeCommands(program: Command): void {
  const admin = requireGroup(program, 'admin')
  const monitor = requireGroup(program, 'monitor')
  registerBrokerReads(monitor)
  registerAdminRuntimeCommands(admin)
  registerAdminBrokerVerify(admin)
  registerAdminEvents(admin)
  registerAdminRegistrations(admin)

  const runtime = program.command('runtime').description('list, inspect, and control runtimes')

  runtime
    .command('list')
    .description('list runtimes (use `hrc show <scope>` or `runtime inspect <id>` for one target)')
    .option('--host-session-id <id>', 'filter by host session')
    .option('--session <id>', 'filter by host session (post-mortem discovery alias)')
    .option('--transport <transport>', 'filter by transport (tmux|headless|sdk)')
    .option('--status <status>', 'filter by status (busy|dead|ready|stale|terminated|detached)')
    .option('--scope <scope>', 'filter by scope ref or target handle')
    .option('--agent <agent>', 'filter by exact agent ID')
    .option('--task <task>', 'filter by exact task ID')
    .option('--older-than <duration>', 'filter by age')
    .option('--json', 'output as JSON')
    .option('--stale', 'show only stale runtimes')
    .option('--all', 'include terminal runtime history')
    .option('--all-nodes', 'best-effort node-labeled inventory across configured peers')
    .addHelpText(
      'after',
      '\nSingle-target queries:\n  hrc show <scope>\n  hrc runtime inspect <runtimeId>\n'
    )
    .action(async (_opts, cmd: Command) => {
      await cmdRuntimeList(
        toLegacyArgv([], cmd.opts(), {
          strings: [
            'host-session-id',
            'session',
            'transport',
            'status',
            'scope',
            'agent',
            'task',
            'older-than',
          ],
          booleans: ['json', 'stale', 'all', 'all-nodes'],
        })
      )
    })

  runtime
    .command('inspect')
    .description('inspect nested HRC and broker authority views for a runtime')
    .argument('<runtimeId>', 'runtime ID')
    .option('--probe', 'request a live broker liveness probe (capability-gated)')
    .option('--json', 'output nested {hrc, broker} authority views as JSON')
    .action(async (runtimeId, _opts, cmd: Command) => {
      await cmdRuntimeInspect(
        toLegacyArgv([runtimeId], cmd.opts(), {
          strings: [],
          booleans: ['probe', 'json'],
        })
      )
    })

  runtime
    .command('status')
    .description('show runtime lifecycle and broker capture status')
    .argument('<target>', 'runtime ID, scope ref, or target handle')
    .option('--json', 'output runtime and capture status as JSON')
    .action(async (target, _opts, cmd: Command) => {
      await cmdRuntimeStatus(
        toLegacyArgv([target], cmd.opts(), {
          strings: [],
          booleans: ['json'],
        })
      )
    })

  runtime
    .command('diagnostics')
    .description(
      'list first_turn_missing trips, or print one trip and its diagnostic bundle (read-only)'
    )
    .argument('[selector]', "trip event id, or a runtime ID / scope to list that runtime's trips")
    .option('--json', 'output as JSON')
    .addHelpText(
      'after',
      '\nA first_turn_missing trip means a prompt was dispatched to a runtime generation and the harness never produced turn.started before its deadline (trust dialog, onboarding prompt, wedged TUI). The trip event id is carried by the durable event, the `runtime list` health detail, and every waiter error.\n'
    )
    .action(async (selector, _opts, cmd: Command) => {
      await cmdRuntimeDiagnostics(
        toLegacyArgv(selector ? [selector] : [], cmd.opts(), {
          strings: [],
          booleans: ['json'],
        })
      )
    })

  runtime
    .command('capture')
    .description('capture live runtime output')
    .argument('<runtimeId>', 'runtime ID')
    .action(async (runtimeId) => {
      await cmdCapture([runtimeId])
    })

  runtime
    .command('send')
    .description('send input to an active run')
    .argument('<runtimeId>', 'runtime ID')
    .requiredOption('--run-id <id>', 'active run ID')
    .requiredOption('--input <input>', 'input text')
    .option('--input-type <type>', 'input type')
    .action(async (runtimeId, _opts, cmd: Command) => {
      await cmdInflightSend(
        toLegacyArgv([runtimeId], cmd.opts(), {
          strings: ['run-id', 'input', 'input-type'],
          booleans: [],
        })
      )
    })

  runtime
    .command('interrupt')
    .description('interrupt a runtime')
    .argument('<runtimeId>', 'runtime ID')
    .action(async (runtimeId) => {
      await cmdInterrupt([runtimeId])
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
      const rawArgv = rawArgvForVerb(cmd, 'terminate')
      await cmdTerminate(
        toLegacyArgv(
          [runtimeId],
          cmd.opts(),
          {
            strings: ['reason', 'source'],
            booleans: [],
            negatedBooleans: ['drop-continuation'],
          },
          rawArgv
        )
      )
    })

  runtime
    .command('sweep')
    .description(
      'liveness-gate aged ready,busy runtimes; stale abandoned rows, then use runtime prune'
    )
    .option('--transport <transport>', 'filter by transport (tmux|headless|sdk)')
    .option('--status <status>', 'filter by status')
    .option('--scope <scope>', 'filter by scope')
    .option('--older-than <duration>', 'filter by age')
    .option('--dry-run', 'preview without mutating')
    .option('--yes', 'confirm mutation')
    .option('--json', 'output as JSON')
    .option('--drop-continuation', 'drop continuation on sweep')
    .action(async (_opts, cmd: Command) => {
      await cmdRuntimeSweep(
        toLegacyArgv([], cmd.opts(), {
          strings: ['transport', 'status', 'scope', 'older-than'],
          booleans: ['dry-run', 'yes', 'json', 'drop-continuation'],
        })
      )
    })

  runtime
    .command('prune')
    .description('prune orphaned stale runtime store records (deletes rows; distinct from sweep)')
    .option('--transport <transport>', 'filter by transport (tmux|headless|sdk)')
    .option('--status <status>', 'filter by status (default: stale)')
    .option('--scope <scope>', 'filter by scope')
    .option('--older-than <duration>', 'filter by age (default: 24h)')
    .option('--dry-run', 'preview without deleting')
    .option('--yes', 'confirm deletion')
    .option('--json', 'output as JSON')
    .action(async (_opts, cmd: Command) => {
      await cmdRuntimePrune(
        toLegacyArgv([], cmd.opts(), {
          strings: ['transport', 'status', 'scope', 'older-than'],
          booleans: ['dry-run', 'yes', 'json'],
        })
      )
    })

  registerMovedCommandShim(runtime, 'ensure', 'hrc admin runtime ensure')
  registerMovedCommandShim(runtime, 'adopt', 'hrc admin runtime adopt')
  registerLegacyBrokerShim(program)
  registerMovedCommandShim(program, 'events', 'hrc admin events drain')
  registerMovedCommandShim(program, 'launch', 'hrc ls launches')

  annotateCommand(runtime, { audience: 'human' })
  annotateChild(runtime, 'list', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc runtime list --status busy --task T-07011 --json',
      exitCodes: '0 success; 2 usage; 1 read/federation failure',
      output: 'one JSON array locally; --all-nodes returns a node-labeled projection',
    },
  })
  annotateChild(runtime, 'inspect', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc runtime inspect runtime:<id> --json',
      exitCodes: '0 success; 2 selector/usage error; 1 read/probe failure',
      output: '--json preserves separate hrc and broker authority objects',
    },
  })
  annotateChild(runtime, 'diagnostics', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc runtime diagnostics 41822 --json',
      exitCodes: '0 success; 2 usage; 1 read failure or unknown trip',
      output: 'trips list, or one trip plus its redacted bundle manifest',
    },
  })
  annotateChild(runtime, 'terminate', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc runtime terminate runtime:<id> --no-drop-continuation',
      exitCodes: '0 terminated; 2 usage/conflicting flags; 1 termination failure',
      output: 'mutation result; choose continuation preservation explicitly',
    },
  })
  annotateChild(monitor, 'events', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc monitor events runtime:<id> --latest --ndjson',
      exitCodes: '0 success; 2 usage; 1 read failure',
      output: '--ndjson is one broker event per line; --seq is invocation-local',
    },
  })
  annotateChild(monitor, 'transcript', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc monitor transcript cody@hrc-runtime:T-07011 --previous --tail 100',
      exitCodes: '0 success; 2 usage; 1 read failure',
      output: 'invocation activity, not conversation readback; events --ndjson is structured',
    },
  })
  annotateChild(monitor, 'stats', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc monitor stats runtime:<id> --latest --json',
      exitCodes: '0 success; 2 usage; 1 read failure',
      output: '--json emits one invocation-ledger summary',
    },
  })
}
