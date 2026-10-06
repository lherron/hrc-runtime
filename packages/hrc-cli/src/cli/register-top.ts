import { type Command, Option } from 'commander'

import { cmdRunAnnotate, cmdRunExport } from '../run-invocation.js'
import { cmdPeek, cmdSend, cmdSummon } from '../target/live-commands.js'
import { cmdTurn } from '../turn/commands/turn.js'
import { cmdAdminWorktreesPrune } from '../worktree-prune.js'
import {
  assertNoUnknownOptions,
  rawArgvForVerb,
  toLegacyArgv,
  toLegacyArgvForScopeCommand,
} from './argv.js'
import { type CommandMetadataInput, annotateCommand } from './command-metadata.js'
import {
  cmdBridgeClose,
  cmdBridgeDeliver,
  cmdBridgeDeliverText,
  cmdBridgeList,
  cmdBridgeRegister,
  cmdBridgeTarget,
  cmdSurfaceBind,
  cmdSurfaceList,
  cmdSurfaceUnbind,
} from './handlers-control.js'
import { cmdRestartMe } from './handlers-restartme.js'
import {
  cmdLs,
  cmdRunReconcileActive,
  cmdRunRecoverUnstarted,
  cmdRunSweepZombies,
  cmdShow,
} from './handlers-runtime.js'
import { cmdAttach, cmdResumeContinuation, cmdRun, cmdStart } from './handlers-scope-cmd.js'
import { cmdAdminStatus } from './handlers-server.js'
import {
  legacyArgvSchema,
  resumeOptions,
  runOptions,
  startOptions,
  unknownOptionSchema,
} from './scope-verb-options.js'
import { createClient } from './shared.js'

function annotateTop(program: Command, name: string, metadata: CommandMetadataInput): void {
  const command = program.commands.find((candidate) => candidate.name() === name)
  if (!command) throw new Error(`missing registered command hrc ${name}`)
  annotateCommand(command, metadata)
}

/** Attach a scope verb's declared options (scope-verb-options.ts), keeping the builder chain. */
function withOptions(command: Command, options: readonly Option[]): Command {
  for (const option of options) command.addOption(option)
  return command
}

export function registerTopLevelCommands(program: Command): void {
  // -- top-level commands (commander, Phase 6 T2b) -----------------------------

  withOptions(
    program
      .command('start')
      .description('start a managed runtime')
      .argument('[scope]', 'agent scope (agent, agent@project, or full scope ref)')
      .allowExcessArguments(true)
      .allowUnknownOption(true),
    startOptions()
  ).action(async (_scope, _opts, cmd: Command) => {
    // cmdStart/cmdRun use parseScopePrompt which handles positional
    // prompts, -p, and --prompt-file.  Reconstruct the full legacy
    // argv from commander's parsed positionals + options.
    const positionals: string[] = cmd.args
    const opts = cmd.opts()
    const rawArgv = rawArgvForVerb(cmd, 'start', { offset: 1 })
    assertNoUnknownOptions(rawArgv, unknownOptionSchema(cmd.options))
    const args = toLegacyArgvForScopeCommand(
      positionals,
      opts,
      rawArgv,
      legacyArgvSchema(cmd.options)
    )
    await cmdStart(args)
  })

  const run = withOptions(
    program
      .command('run')
      .description('launch or reattach and attach')
      .argument('[scope]', 'agent scope (agent, agent@project, or full scope ref)')
      .allowExcessArguments(true)
      .allowUnknownOption(true),
    runOptions()
  ).action(async (_scope, _opts, cmd: Command) => {
    const positionals: string[] = cmd.args
    if (positionals[0] === 'export') {
      await cmdRunExport(rawArgvForVerb(cmd, 'run', { offset: 2, fallback: process.argv.slice(2) }))
      return
    }
    if (positionals[0] === 'annotate') {
      await cmdRunAnnotate(
        rawArgvForVerb(cmd, 'run', { offset: 2, fallback: process.argv.slice(2) })
      )
      return
    }
    const opts = cmd.opts()
    const rawArgv = rawArgvForVerb(cmd, 'run', { offset: 1 })
    assertNoUnknownOptions(rawArgv, unknownOptionSchema(cmd.options))
    const args = toLegacyArgvForScopeCommand(
      positionals,
      opts,
      rawArgv,
      legacyArgvSchema(cmd.options)
    )
    await cmdRun(args)
  })

  // -- run invocation exposure (H-00104 Node C, C-0004) -----------------------
  run
    .command('export')
    .description('export a run as the stable HrcInvocationExposure DTO (invocation DAG surface)')
    .argument('<runId-or-selector>', 'run id, or a runtime:/scope:/session:/host: selector')
    .option('--format <mode>', 'projection format (invocation-exposure)', 'invocation-exposure')
    .option('--json', 'output as JSON (the DTO is always JSON)')
    .action(async (target, _opts, cmd: Command) => {
      const args = toLegacyArgv([target], cmd.opts(), {
        strings: ['format'],
        booleans: ['json'],
      })
      await cmdRunExport(args)
    })

  run
    .command('annotate')
    .description(
      'stamp opaque correlation metadata on a run (operator convenience; not graph truth)'
    )
    .argument('<runId>', 'run id, or a selector resolving to one run')
    .option(
      '--correlation <json>',
      'JSON: {invocationNodeId?,attemptRef?,taskId?,workflowInstanceId?}'
    )
    .option('--replace', 'overwrite an existing, conflicting correlation')
    .option('--json', 'output as JSON')
    .action(async (target, _opts, cmd: Command) => {
      const args = toLegacyArgv([target], cmd.opts(), {
        strings: ['correlation'],
        booleans: ['replace', 'json'],
      })
      await cmdRunAnnotate(args)
    })

  // -- resume (T-04836 Part A) -------------------------------------------------
  // `resume` is its OWN verb — force-resume the latest stored continuation for a
  // target regardless of HRC status. It is NOT an alias of `run`: it never
  // fresh-launches and never attaches as a substitute for resume. For attach-only
  // behavior use `hrc attach <scope>`; for start/reuse/attach use `hrc run`.
  withOptions(
    program
      .command('resume')
      .description('resume the latest stored continuation for a target (regardless of status)')
      .argument('[scope]', 'agent scope (agent, agent@project, or full scope ref)')
      .allowExcessArguments(true)
      .allowUnknownOption(true),
    resumeOptions()
  )
    .addHelpText(
      'after',
      `
Semantics:
  resume force-resumes the selected stored continuation for a target: newest by
  default, the active session's predecessor with --prior, or an exact historical
  row with --host-session. Selection is REGARDLESS of HRC status (archived /
  dormant / broken / removed-orphaned).
  Unlike \`hrc run\`, it requires a captured continuation: if none has ever been
  recorded, it fails clearly and does NOT start fresh. Clear/drop/terminate audit
  events never erase or invalidate a recorded continuation for explicit resume.
  For attach-only behavior use \`hrc attach <scope>\`; for start/reuse/attach use
  \`hrc run <scope>\`.
`
    )
    .action(async (_scope, _opts, cmd: Command) => {
      const positionals: string[] = cmd.args
      const opts = cmd.opts()
      const rawArgv = rawArgvForVerb(cmd, 'resume', { offset: 1 })
      assertNoUnknownOptions(rawArgv, unknownOptionSchema(cmd.options))
      const args = toLegacyArgvForScopeCommand(
        positionals,
        opts,
        rawArgv,
        legacyArgvSchema(cmd.options)
      )
      await cmdResumeContinuation(args)
    })

  // -- admin group (run-RECORD repair, distinct from runtime sweep) -----------
  const admin = program.command('admin').description('administrative maintenance commands')
  admin
    .command('status')
    .description('show effective ASP child toolchain selection and observed handshakes')
    .option('--json', 'output the ASP toolchain report as JSON')
    .action(async (...actionArgs: unknown[]) => {
      const cmd = actionArgs[actionArgs.length - 1] as Command
      await cmdAdminStatus(toLegacyArgv([], cmd.opts(), { strings: [], booleans: ['json'] }))
    })
  const adminRuns = admin
    .command('runs')
    .description('repair run records (sweep zombies, reconcile active)')

  const adminWorktrees = admin
    .command('worktrees')
    .description('audit and prune completed-task linked worktrees')

  adminWorktrees
    .command('audit')
    .description('audit completed-task linked worktrees without removing them')
    .option('--project <id>', 'inspect one registered project')
    .option('--root <path>', 'override its canonical root (requires --project)')
    .option('--json', 'output as JSON')
    .action(async (...actionArgs: unknown[]) => {
      const cmd = actionArgs[actionArgs.length - 1] as Command
      cmdAdminWorktreesPrune({ ...cmd.opts(), dryRun: true })
    })

  adminWorktrees
    .command('prune')
    .description('remove only completed, clean worktrees already merged into canonical HEAD')
    .option('--project <id>', 'inspect one registered project')
    .option('--root <path>', 'override its canonical root (requires --project)')
    .option('--dry-run', 'preview without removing worktrees (default)')
    .option('--yes', 'remove eligible worktrees without force; branches are preserved')
    .option('--json', 'output as JSON')
    .action(async (...actionArgs: unknown[]) => {
      const cmd = actionArgs[actionArgs.length - 1] as Command
      cmdAdminWorktreesPrune(cmd.opts())
    })

  adminRuns
    .command('sweep-zombies')
    .description('sweep stale active runs into zombie terminal state')
    .option('--older-than <duration>', 'run inactivity threshold')
    .option('--dry-run', 'preview without mutating')
    .option('--yes', 'confirm mutation')
    .option('--json', 'output as JSON')
    .action(async (...actionArgs: unknown[]) => {
      const cmd = actionArgs[actionArgs.length - 1] as Command
      const rawArgv = rawArgvForVerb(cmd, 'sweep-zombies', { offset: 1, fallback: [] })
      await cmdRunSweepZombies(rawArgv)
    })

  adminRuns
    .command('reconcile-active')
    .description('reconcile active runs whose runtime lifecycle is already terminal or idle')
    .option('--older-than <duration>', 'run inactivity threshold')
    .option('--dry-run', 'preview without mutating')
    .option('--yes', 'confirm mutation')
    .option('--json', 'output as JSON')
    .action(async (...actionArgs: unknown[]) => {
      const cmd = actionArgs[actionArgs.length - 1] as Command
      const rawArgv = rawArgvForVerb(cmd, 'reconcile-active', { offset: 1, fallback: [] })
      await cmdRunReconcileActive(rawArgv)
    })

  adminRuns
    .command('recover-unstarted')
    .description(
      'recover one accepted run that never started by withdrawing its exact broker submission'
    )
    .argument('<runId>', 'accepted run id')
    .option('--dry-run', 'preview without mutating (default unless --yes)')
    .option('--yes', 'confirm the exact withdrawal and bounded recovery')
    .option('--json', 'output the structured recovery result')
    .action(async (_runId, _opts, cmd: Command) => {
      const rawArgv = rawArgvForVerb(cmd, 'recover-unstarted', { offset: 1, fallback: [] })
      await cmdRunRecoverUnstarted(rawArgv)
    })

  // -- show / ls (T-04219 P2: context-aware viewer + noun lister) --------------
  program
    .command('show')
    .description('show a runtime, host session, or message by selector')
    .argument(
      '<selector>',
      'selector: runtimeId, runtime:<id>, host:<id>, scope:<ref>, msg:<id>, seq:<n>'
    )
    .option('--json', 'output structured JSON (stable shape: kind + concrete id)')
    .addHelpText(
      'after',
      `
Resolution order for a bare selector: runtime, then host-session, then message.
Explicit prefixes (runtime:, host:, scope:, msg:, seq:) are honored directly.
The output always names the resolved kind and the concrete ID(s).
`
    )
    .action(async (selector, _opts, cmd: Command) => {
      const args = toLegacyArgv([selector], cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdShow(args)
    })

  program
    .command('ls')
    .alias('list')
    .description('list runtimes | sessions | messages')
    .argument('<noun>', 'runtimes | sessions | messages')
    .option('--json', 'output as JSON')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (noun: string, _opts, cmd: Command) => {
      const rawRest = rawArgvForVerb(cmd, 'ls', { offset: 2, fallback: cmd.args.slice(1) })
      const rest: string[] = []
      for (let index = 0; index < rawRest.length; index += 1) {
        const arg = rawRest[index]
        if (arg === '--output' && rawRest[index + 1] === 'json') {
          index += 1
          continue
        }
        if (arg === '--output=json') continue
        rest.push(arg as string)
      }
      if (cmd.opts<{ json?: boolean }>().json && !rest.includes('--json')) {
        rest.push('--json')
      }
      assertNoUnknownOptions(rest, {
        boolean: [
          '--stale',
          '--json',
          '--all-nodes',
          '--porcelain',
          '--all',
          '--dormant',
          '--gens',
          '--by-project',
        ],
        value: [
          '--host-session-id',
          '--session',
          '--transport',
          '--status',
          '--older-than',
          '--scope',
          '--agent',
          '--task',
          '--lane',
          '--since',
          '--runtime-id',
        ],
      })
      await cmdLs(noun, rest)
    })

  // -- turn --------------------------------------------------------------------

  program
    .command('turn')
    .description('dispatch tracked work or attach to an admitted turn and stream its progress')
    .argument('<target>', 'target handle or scopeRef')
    .argument('[prompt]', 'prompt text (use - for stdin)')
    .option('--attach', "observe the target's admitted turn without dispatching")
    .option('--as <principal>', 'explicit sender principal')
    .option('--fresh-context, --new', 'clear context before dispatching (clean slate)')
    .option('--dry-run', 'resolve and print the dispatch plan without dispatching')
    .option('--format <format>', 'output format: tree, compact, ndjson, json')
    .option('--pretty', 'force the human-facing terminal render even on non-TTY')
    .option('--stall-after <duration>', 'abort if idle for this long', '1h')
    .option('--stacked <duration>', 'emit bounded turn_stacked ndjson progress')
    .option('--follow <duration>', 'alias for --stacked')
    .option('--wait <mode>', 'block quietly until terminal, then emit one JSON object')
    .option('--timeout <duration>', 'wait budget for --wait final (default 45m)')
    .option('--quiet', 'suppress all progress output while --wait blocks')
    .option('--reply-to <id>', 'reply to a specific message ID (with --queue)')
    .option('--cross-scope-reply', 'allow --reply-to to thread across conversation scopes')
    .option(
      '--queue',
      'enqueue: run as its own turn after the active one (default door is steer: join the active turn, or start one)'
    )
    .option(
      '--steer',
      'steer: join the active turn, or start one (the default; accepted as a no-op)'
    )
    .option('--preempt', 'interrupt the active turn and start this submission (operator only)')
    .option('--ttl <duration>', 'admission lifetime for --queue or --preempt')
    .option('--file <path>', 'read prompt from file')
    .option(
      '--response-format-json-schema <schema>',
      'request JSON Schema constrained final response (inline JSON object or file path)'
    )
    // `hrcchat` exposed --json globally, so it was accepted by the old forwarding
    // path without appearing in turn help. Preserve that exact surface here.
    .addOption(new Option('--json', 'suppress human error text').hideHelp())
    .action(async (target, prompt, opts) => {
      await cmdTurn(createClient(), { ...opts }, [
        target,
        ...(prompt !== undefined ? [prompt] : []),
      ])
    })

  // -- live-runtime verbs absorbed from hrcchat (T-07612 §9.2) ----------------
  //
  // These are execution: materialize a target, inject keystrokes, read a pane,
  // check reachability. Messaging moves the other way, to `wrkc`, because it is
  // collaboration and wrkq owns that.

  program
    .command('summon')
    .description('materialize/pre-warm a target; message traffic auto-summons when needed')
    .argument('<target>', 'target handle')
    .option('--json', 'emit the ensure-target result as JSON')
    .action(async (target, opts) => {
      await cmdSummon(createClient(), { json: opts.json === true }, [target])
    })

  program
    .command('restartme')
    .description(
      'restart this agent into a fresh context when the current turn ends (needs a pending wrkq handoff)'
    )
    .option('--handoff <id>', 'the pending wrkq handoff the successor will consume')
    .option('--cancel', 'disarm a restart armed earlier')
    .action(async (opts) => {
      await cmdRestartMe({
        ...(opts.handoff === undefined ? {} : { handoff: String(opts.handoff) }),
        cancel: opts.cancel === true,
      })
    })

  const sendCmd = program
    .command('send')
    .description(
      'inject literal input into a live tmux runtime; no envelope or obligation; not for tracked work'
    )
    .argument('<target>', 'target handle')
    .argument('[message]', 'text to send (use - for stdin)')
    .option('--enter', 'send enter key after text (default)')
    .option(
      '--no-enter',
      'do not send enter key; on a broker-hosted runtime the text is held by the daemon, not typed (see below)'
    )
    .option('--file <path>', 'read body from file')
    .option('--json', 'emit the delivery result as JSON')
    .action(async (target, message, opts) => {
      await cmdSend(createClient(), { ...opts, json: opts.json === true }, [
        target,
        ...(message !== undefined ? [message] : []),
      ])
    })

  sendCmd.addHelpText(
    'before',
    'Inject literal text into a live tmux runtime (raw keystrokes).\n\nNOT A MESSAGE: what you send here becomes no wrkc envelope and no obligation, so\nno one owes a reply and it is not in any room history. HRC still records the\ndelivery: a send that submits returns a runId, and its turn lands in hrc_events,\nbut that is runtime evidence, not tracked work. Use `wrkc say` for anything\nthat should survive the runtime.\n'
  )
  sendCmd.addHelpText(
    'after',
    '\n--no-enter on a broker-hosted runtime (every `hrc start`/summon birth) does not\ntype into the pane. The daemon holds the text in memory and prepends it to the\nnext send that presses enter, which submits both as one prompt. So `hrc peek`\nshows an empty input line after it, and a daemon restart drops the held text.\nProve an unsubmitted send by the next submission, not by peek.\n'
  )

  program
    .command('peek')
    .description('tail the live tmux pane of a bound runtime')
    .argument('<target>', 'target handle')
    .option('--lines <n>', 'number of lines to capture', '80')
    .option('--json', 'emit the capture as JSON')
    .action(async (target, opts) => {
      await cmdPeek(createClient(), { ...opts, json: opts.json === true }, [target])
    })

  program
    .command('attach')
    .description('attach to a live runtime')
    .argument('[scope]', 'scope or runtime ID to attach to')
    .option('--dry-run', 'local plan preview — no side effects')
    .option(
      '--json',
      'emit the --dry-run plan as JSON; on error, emit structured JSON (includes broker rejection detail)'
    )
    .action(async (scope, _opts, cmd: Command) => {
      const positionals = scope !== undefined ? [scope] : []
      const args = toLegacyArgv(positionals, cmd.opts(), {
        strings: [],
        booleans: ['dry-run', 'json'],
      })
      await cmdAttach(args)
    })

  // -- admin cellar ------------------------------------------------------------

  const surface = admin.command('surface').description('manage surface bindings')

  surface
    .command('bind')
    .description('bind a surface')
    .argument('<runtimeId>', 'runtime ID')
    .option('--kind <kind>', 'surface kind')
    .option('--id <id>', 'surface ID')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: ['kind', 'id'],
        booleans: [],
      })
      await cmdSurfaceBind(args)
    })

  surface
    .command('unbind')
    .description('unbind a surface')
    .option('--kind <kind>', 'surface kind')
    .option('--id <id>', 'surface ID')
    .option('--reason <reason>', 'reason for unbinding')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['kind', 'id', 'reason'],
        booleans: [],
      })
      await cmdSurfaceUnbind(args)
    })

  surface
    .command('list')
    .description('list surface bindings')
    .argument('<runtimeId>', 'runtime ID')
    .option('--json', 'output as JSON')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdSurfaceList(args)
    })

  const bridge = admin.command('bridge').description('manage low-level local bridge delivery')

  bridge
    .command('target')
    .description('acquire bridge target')
    .option('--bridge <bridge>', 'convenience alias for --transport tmux --target <value>')
    .option('--host-session <id>', 'host session selector')
    .option('--session-ref <ref>', 'session ref selector')
    .option('--transport <transport>', 'bridge transport')
    .option('--target <target>', 'bridge target')
    .option('--runtime-id <id>', 'runtime ID')
    .option('--expected-host-session-id <id>', 'expected host session ID')
    .option('--expected-generation <n>', 'expected generation')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: [
          'bridge',
          'host-session',
          'session-ref',
          'transport',
          'target',
          'runtime-id',
          'expected-host-session-id',
          'expected-generation',
        ],
        booleans: [],
      })
      await cmdBridgeTarget(args)
    })

  bridge
    .command('deliver-text')
    .description('deliver text to a bridge')
    .option('--bridge <bridge>', 'bridge ID')
    .option('--text <text>', 'text to deliver')
    .option('--oob-suffix <suffix>', 'out-of-band suffix')
    .option('--expected-host-session-id <id>', 'expected host session ID')
    .option('--expected-generation <n>', 'expected generation')
    .option('--enter', 'send enter after text')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: [
          'bridge',
          'text',
          'oob-suffix',
          'expected-host-session-id',
          'expected-generation',
        ],
        booleans: ['enter'],
      })
      await cmdBridgeDeliverText(args)
    })

  bridge
    .command('register')
    .description('register a bridge')
    .argument('<hostSessionId>', 'host session ID')
    .option('--transport <transport>', 'bridge transport')
    .option('--target <target>', 'bridge target')
    .option('--runtime-id <id>', 'runtime ID')
    .option('--expected-host-session-id <id>', 'expected host session ID')
    .option('--expected-generation <n>', 'expected generation')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: [
          'transport',
          'target',
          'runtime-id',
          'expected-host-session-id',
          'expected-generation',
        ],
        booleans: [],
      })
      await cmdBridgeRegister(args)
    })

  bridge
    .command('deliver')
    .description('deliver to a bridge')
    .argument('<bridgeId>', 'bridge ID')
    .option('--text <text>', 'text to deliver')
    .option('--expected-host-session-id <id>', 'expected host session ID')
    .option('--expected-generation <n>', 'expected generation')
    .action(async (bridgeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([bridgeId], cmd.opts(), {
        strings: ['text', 'expected-host-session-id', 'expected-generation'],
        booleans: [],
      })
      await cmdBridgeDeliver(args)
    })

  bridge
    .command('list')
    .description('list bridges')
    .argument('<runtimeId>', 'runtime ID')
    .option('--json', 'output as JSON')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdBridgeList(args)
    })

  bridge
    .command('close')
    .description('close a bridge')
    .argument('<bridgeId>', 'bridge ID')
    .action(async (bridgeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([bridgeId], cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdBridgeClose(args)
    })

  annotateCommand(admin, { audience: 'human' })
  annotateTop(program, 'run', {
    audience: 'both',
    humanExample: 'hrc run <target>',
    agentUsage: {
      example: 'hrc run cody@hrc-runtime:T-07011',
      exitCodes: '0 attached session ended normally; 2 usage; 1 launch/attach failure',
      output: 'interactive TTY flow; use start for detached automation',
    },
  })
  annotateTop(program, 'attach', {
    audience: 'both',
    humanExample: 'hrc attach <target>',
    agentUsage: {
      example: 'hrc attach cody@hrc-runtime:T-07011 --dry-run',
      exitCodes: '0 attached or plan emitted; 2 usage; 1 when no live runtime exists',
      output: '--dry-run emits the attach plan without launching or mutating',
    },
  })
  annotateTop(program, 'start', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc start cody@hrc-runtime:T-07011 -p "Continue."',
      exitCodes: '0 provisioned; 2 usage; 1 launch failure',
      output: 'detached provision result; --json structures errors',
    },
  })
  annotateTop(program, 'resume', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc resume cody@hrc-runtime:T-07011',
      exitCodes:
        '0 continuation resumed; 2 usage; 1 invalidated/missing continuation or launch failure',
      output: 'continuation-only recovery; never fresh-launches and refuses --force-restart',
    },
  })
  annotateTop(program, 'show', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc show scope:agent:cody:project:hrc-runtime:task:T-07011 --json',
      exitCodes: '0 resolved; 2 usage/ambiguity; 1 read failure',
      output: '--json names the resolved kind plus concrete IDs',
    },
  })
  annotateTop(program, 'ls', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc ls runtimes --status busy --json',
      exitCodes: '0 success; 2 invalid noun/flags; 1 read failure',
      output: 'noun-specific structured output; narrow large runtime lists with filters',
    },
  })
  annotateTop(program, 'summon', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc summon cody@hrc-runtime:T-07011',
      exitCodes: '0 target materialized or already live; 2 usage; 1 summon refused or failed',
      output: 'sessionRef, state, generation, and the dm/send/peek capability triple',
    },
  })
  annotateTop(program, 'send', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc send cody@hrc-runtime:T-07011 "y"',
      exitCodes: '0 delivered; 2 usage; 1 no live runtime to inject into',
      output:
        'raw keystrokes into a live pane; returns a runId and lands in hrc_events, but no wrkc envelope or obligation — use `wrkc say` for tracked work',
    },
  })
  annotateTop(program, 'peek', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc peek cody@hrc-runtime:T-07011 --lines 40',
      exitCodes: '0 captured; 2 usage; 1 no bound runtime',
      output: 'the pane text as captured; --json wraps it with capture metadata',
    },
  })
  annotateTop(program, 'restartme', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc restartme --handoff H-00123',
      exitCodes:
        '0 armed or cancelled; 1 refused (no handoff, wrong-scope or non-pending handoff, no credential, no active turn); 2 usage',
      output:
        'write a handoff (wrkq handoff create --scope <agent>@<project>), arm, then END YOUR TURN; the successor (generation+1, fresh context) starts by consuming the handoff',
    },
  })
  annotateTop(program, 'turn', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc turn cody@hrc-runtime:T-07011 "Continue."',
      exitCodes: 'the dispatched turn exit code',
      output: 'streams the turn output verbatim',
    },
  })
}
