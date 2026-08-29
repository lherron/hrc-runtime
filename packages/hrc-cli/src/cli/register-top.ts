import { type Command, Option } from 'commander'

import { cmdAdminReleaseSweep } from '../release-gc-sweep.js'
import { cmdAdminReleaseGc } from '../release-gc.js'
import { cmdRunAnnotate, cmdRunExport } from '../run-invocation.js'
import { cmdPeek, cmdSend, cmdSummon } from '../target/live-commands.js'
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
  execHrcchatTurn,
} from './handlers-control.js'
import { cmdLs, cmdRunReconcileActive, cmdRunSweepZombies, cmdShow } from './handlers-runtime.js'
import { cmdAttach, cmdResumeContinuation, cmdRun, cmdStart } from './handlers-scope-cmd.js'
import { registerMovedCommandShim, throwMovedCommand } from './moved-command.js'
import { createClient } from './shared.js'

function annotateTop(program: Command, name: string, metadata: CommandMetadataInput): void {
  const command = program.commands.find((candidate) => candidate.name() === name)
  if (!command) throw new Error(`missing registered command hrc ${name}`)
  annotateCommand(command, metadata)
}

export function registerTopLevelCommands(program: Command): void {
  // -- top-level commands (commander, Phase 6 T2b) -----------------------------

  program
    .command('start')
    .description('start a managed runtime')
    .argument('[scope]', 'agent scope (agent, agent@project, or full scope ref)')
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .option('--force-restart', 'replace existing runtime with a fresh PTY')
    .option('--new-session', 'rotate to a fresh host session before starting')
    .option('--dry-run', 'local plan preview — no server calls')
    .option('--debug', 'keep tmux shell alive after harness exits')
    .option('--no-register', 'do not prompt to register cwd as a project marker')
    .option('--json', 'on error, emit structured JSON (includes broker rejection detail)')
    .option('--project-id <id>', 'override the inferred project id')
    .option('--project-root <path>', 'override project root')
    .option('--idempotency-key <key>', 'stable retry identity for the prompt dispatch')
    .option('--viewer-window <key>', 'place this session viewer tab in the keyed window')
    .addOption(
      new Option(
        '--on-conflict <policy>',
        'suffix: claim the next free roster slot instead of hijacking a live :primary; reject: claim exactly this scope or refuse'
      ).choices(['suffix', 'reject'])
    )
    .option('-p <text>', 'initial prompt to send to the harness')
    .option('--prompt-file <path>', 'read initial prompt from a file')
    .addOption(
      new Option('--wait [mode]', 'wait for the prompt turn to start or become terminal')
        .choices(['started', 'completed'])
        .preset('completed')
    )
    .action(async (_scope, _opts, cmd: Command) => {
      // cmdStart/cmdRun use parseScopePrompt which handles positional
      // prompts, -p, and --prompt-file.  Reconstruct the full legacy
      // argv from commander's parsed positionals + options.
      const positionals: string[] = cmd.args
      const opts = cmd.opts()
      const rawArgv = rawArgvForVerb(cmd, 'start', { offset: 1 })
      assertNoUnknownOptions(rawArgv, {
        boolean: [
          '--force-restart',
          '--new-session',
          '--dry-run',
          '--debug',
          '--no-register',
          '--json',
        ],
        value: [
          '--project-id',
          '--project-root',
          '--idempotency-key',
          '--viewer-window',
          '--on-conflict',
          '-p',
          '--prompt-file',
        ],
        optionalValue: ['--wait'],
      })
      const args = toLegacyArgvForScopeCommand(positionals, opts, rawArgv, {
        strings: [
          'project-id',
          'project-root',
          'prompt-file',
          'idempotency-key',
          'viewer-window',
          'on-conflict',
          'wait',
        ],
        booleans: ['force-restart', 'new-session', 'dry-run', 'debug', 'json'],
        negatedBooleans: ['register'],
      })
      await cmdStart(args)
    })

  const run = program
    .command('run')
    .description('launch or reattach and attach')
    .argument('[scope]', 'agent scope (agent, agent@project, or full scope ref)')
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .option('--force-restart', 'replace existing runtime with a fresh PTY')
    .option(
      '--attach-only',
      'reattach to the existing runtime without starting one (like `hrc attach`)'
    )
    .option('--dry-run', 'local plan preview — no server calls')
    .option('--debug', 'keep tmux shell alive after harness exits')
    .option('--no-register', 'do not prompt to register cwd as a project marker')
    .option('--json', 'on error, emit structured JSON (includes broker rejection detail)')
    .option('--project-id <id>', 'override the inferred project id')
    .option('--project-root <path>', 'override project root')
    .option('-p <text>', 'initial prompt to send to the harness')
    .option('--prompt-file <path>', 'read initial prompt from a file')
    .action(async (_scope, _opts, cmd: Command) => {
      const positionals: string[] = cmd.args
      if (positionals[0] === 'export') {
        await cmdRunExport(
          rawArgvForVerb(cmd, 'run', { offset: 2, fallback: process.argv.slice(2) })
        )
        return
      }
      if (positionals[0] === 'annotate') {
        await cmdRunAnnotate(
          rawArgvForVerb(cmd, 'run', { offset: 2, fallback: process.argv.slice(2) })
        )
        return
      }
      if (positionals[0] === 'sweep-zombies') {
        throwMovedCommand('run sweep-zombies', 'hrc admin runs sweep-zombies')
      }
      if (positionals[0] === 'reconcile-active') {
        throwMovedCommand('run reconcile-active', 'hrc admin runs reconcile-active')
      }
      const opts = cmd.opts()
      const rawArgv = rawArgvForVerb(cmd, 'run', { offset: 1 })
      assertNoUnknownOptions(rawArgv, {
        boolean: [
          '--force-restart',
          '--attach-only',
          '--dry-run',
          '--debug',
          '--no-register',
          '--json',
        ],
        value: ['--project-id', '--project-root', '-p', '--prompt-file'],
      })
      const args = toLegacyArgvForScopeCommand(positionals, opts, rawArgv, {
        strings: ['project-id', 'project-root', 'prompt-file'],
        booleans: ['force-restart', 'attach-only', 'dry-run', 'debug', 'json'],
        negatedBooleans: ['register'],
      })
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

  registerMovedCommandShim(run, 'sweep-zombies', 'hrc admin runs sweep-zombies')
  registerMovedCommandShim(run, 'reconcile-active', 'hrc admin runs reconcile-active')

  // -- resume (T-04836 Part A) -------------------------------------------------
  // `resume` is its OWN verb — force-resume the latest stored continuation for a
  // target regardless of HRC status. It is NOT an alias of `run`: it never
  // fresh-launches and never attaches as a substitute for resume. For attach-only
  // behavior use `hrc attach <scope>`; for start/reuse/attach use `hrc run`.
  program
    .command('resume')
    .description('resume the latest stored continuation for a target (regardless of status)')
    .argument('[scope]', 'agent scope (agent, agent@project, or full scope ref)')
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .option('--no-attach', 'resume and start without attaching to the tmux session')
    .option('--dry-run', 'local plan preview — no server calls')
    .option('--debug', 'keep tmux shell alive after harness exits')
    .option('--no-register', 'do not prompt to register cwd as a project marker')
    .option('--json', 'on error, emit structured JSON (includes broker rejection detail)')
    .option('--project-id <id>', 'override the inferred project id')
    .option('--project-root <path>', 'override project root')
    .option('-p <text>', 'initial prompt to send to the harness')
    .option('--prompt-file <path>', 'read initial prompt from a file')
    .addHelpText(
      'after',
      `
Semantics:
  resume force-resumes the most recent stored continuation for a target,
  REGARDLESS of HRC status (archived / dormant / broken / removed-orphaned).
  Unlike \`hrc run\`, it requires a captured continuation: if none exists, or the
  latest continuation was explicitly invalidated (\`/quit\`, drop-continuation,
  clear-context, terminate-with-drop), it fails clearly and does NOT start fresh.
  For attach-only behavior use \`hrc attach <scope>\`; for start/reuse/attach use
  \`hrc run <scope>\`.
`
    )
    .action(async (_scope, _opts, cmd: Command) => {
      const positionals: string[] = cmd.args
      const opts = cmd.opts()
      const rawArgv = rawArgvForVerb(cmd, 'resume', { offset: 1 })
      assertNoUnknownOptions(rawArgv, {
        boolean: ['--no-attach', '--dry-run', '--debug', '--no-register', '--json'],
        value: ['--project-id', '--project-root', '-p', '--prompt-file'],
      })
      const args = toLegacyArgvForScopeCommand(positionals, opts, rawArgv, {
        strings: ['project-id', 'project-root', 'prompt-file'],
        booleans: ['dry-run', 'debug', 'json'],
        negatedBooleans: ['attach', 'register'],
      })
      await cmdResumeContinuation(args)
    })

  // -- admin group (run-RECORD repair, distinct from runtime sweep) -----------
  // Legacy spellings are registered below as hard moved-command shims.
  const admin = program.command('admin').description('administrative maintenance commands')
  const adminRuns = admin
    .command('runs')
    .description('repair run records (sweep zombies, reconcile active)')

  const adminWorktrees = admin
    .command('worktrees')
    .description('audit and prune completed-task linked worktrees')

  const adminRelease = admin.command('release').description('manage atomic release directories')

  adminRelease
    .command('gc')
    .description(
      'quarantine old atomic release dirs behind installed/running/live-reference fences'
    )
    .option('--keep <n>', 'releases to retain beyond the fences (default 5)')
    .option('--apply', 'quarantine eligible releases (default is dry-run)')
    .option('--restore <releaseId>', 'return one quarantined release to the release root')
    .option('--json', 'output as JSON')
    .action(async (...actionArgs: unknown[]) => {
      const cmd = actionArgs[actionArgs.length - 1] as Command
      cmdAdminReleaseGc(cmd.opts())
    })

  adminRelease
    .command('sweep')
    .description(
      'permanently delete quarantined releases (requires quiescence; dry-run by default)'
    )
    .option('--apply', 'actually delete (default is dry-run)')
    .option('--json', 'output as JSON')
    .action(async (...actionArgs: unknown[]) => {
      const cmd = actionArgs[actionArgs.length - 1] as Command
      cmdAdminReleaseSweep(cmd.opts())
    })

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
    .description('list runtimes | sessions | launches | messages')
    .argument('[noun]', 'runtimes | sessions | launches | messages')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (noun: string | undefined, _opts, cmd: Command) => {
      const rest = rawArgvForVerb(cmd, 'ls', { offset: 2, fallback: cmd.args.slice(1) })
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

  // -- turn (alias for `hrcchat turn`) -----------------------------------------
  // All arguments are forwarded verbatim to `hrcchat turn`. This keeps `hrc turn`
  // in lockstep with `hrcchat turn` without duplicating its flag surface.

  program
    .command('turn')
    .description('dispatch tracked work to an agent and stream its progress')
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]', 'forwarded verbatim to `hrcchat turn`')
    .action(async (_args, _opts, cmd: Command) => {
      const forwarded = rawArgvForVerb(cmd, 'turn', { offset: 1, fallback: [] })
      await execHrcchatTurn(forwarded)
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

  const sendCmd = program
    .command('send')
    .description(
      'inject literal input into a live tmux runtime; bypasses the ledger; not for tracked work'
    )
    .argument('<target>', 'target handle')
    .argument('[message]', 'text to send (use - for stdin)')
    .option('--enter', 'send enter key after text (default)')
    .option('--no-enter', 'do not send enter key')
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
    'Inject literal text into a live tmux runtime (raw keystrokes).\n\nBYPASSES THE LEDGER: what you send here becomes no envelope, no obligation, and\nno record anyone can read afterwards. Use `wrkc say` for anything that should\nsurvive the runtime.\n'
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

  registerMovedCommandShim(program, 'inflight', 'hrc runtime send')
  registerMovedCommandShim(program, 'capture', 'hrc runtime capture')

  program
    .command('attach')
    .description('attach to a live runtime')
    .argument('[scope]', 'scope or runtime ID to attach to')
    .option('--dry-run', 'local plan preview — no server calls')
    .option('--json', 'on error, emit structured JSON (includes broker rejection detail)')
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
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: [],
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
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: [],
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

  registerMovedCommandShim(program, 'surface', 'hrc admin surface')
  registerMovedCommandShim(program, 'bridge', 'hrc admin bridge')

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
        'raw keystrokes into a live pane; BYPASSES THE LEDGER, so nothing sent here is durable — use `wrkc say` for that',
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
  annotateTop(program, 'turn', {
    audience: 'agent',
    agentUsage: {
      example: 'hrc turn cody@hrc-runtime:T-07011 "Continue."',
      exitCodes: 'the dispatched turn exit code',
      output: 'streams the turn output verbatim',
    },
  })
}
