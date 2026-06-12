import type { Command } from 'commander'

import { rawArgvForVerb, toLegacyArgv, toLegacyArgvForScopeCommand } from './argv.js'
import {
  cmdBridgeClose,
  cmdBridgeDeliver,
  cmdBridgeDeliverText,
  cmdBridgeList,
  cmdBridgeRegister,
  cmdBridgeTarget,
  cmdCapture,
  cmdInflightSend,
  cmdSurfaceBind,
  cmdSurfaceList,
  cmdSurfaceUnbind,
  execHrcchatTurn,
} from './handlers-control.js'
import { cmdLs, cmdRunReconcileActive, cmdRunSweepZombies, cmdShow } from './handlers-runtime.js'
import { cmdAttach, cmdRun, cmdStart } from './handlers-scope-cmd.js'

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
    .option('-p <text>', 'initial prompt to send to the harness')
    .option('--prompt-file <path>', 'read initial prompt from a file')
    .action(async (_scope, _opts, cmd: Command) => {
      // cmdStart/cmdRun use parseScopePrompt which handles positional
      // prompts, -p, and --prompt-file.  Reconstruct the full legacy
      // argv from commander's parsed positionals + options.
      const positionals: string[] = cmd.args
      const opts = cmd.opts()
      const rawArgv = rawArgvForVerb(cmd, 'start', { offset: 1 })
      const args = toLegacyArgvForScopeCommand(positionals, opts, rawArgv, {
        strings: ['project-id', 'project-root', 'prompt-file'],
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
    .option('--no-attach', 'start/ensure without attaching to the tmux session')
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
      if (positionals[0] === 'sweep-zombies') {
        await cmdRunSweepZombies(
          rawArgvForVerb(cmd, 'run', { offset: 2, fallback: process.argv.slice(2) }),
          { deprecatedAlias: true }
        )
        return
      }
      if (positionals[0] === 'reconcile-active') {
        await cmdRunReconcileActive(
          rawArgvForVerb(cmd, 'run', { offset: 2, fallback: process.argv.slice(2) }),
          { deprecatedAlias: true }
        )
        return
      }
      const opts = cmd.opts()
      const rawArgv = rawArgvForVerb(cmd, 'run', { offset: 1 })
      const args = toLegacyArgvForScopeCommand(positionals, opts, rawArgv, {
        strings: ['project-id', 'project-root', 'prompt-file'],
        booleans: ['force-restart', 'attach-only', 'dry-run', 'debug', 'json'],
        negatedBooleans: ['attach', 'register'],
      })
      await cmdRun(args)
    })

  run
    .command('sweep-zombies')
    .description(
      'DEPRECATED: use `hrc admin runs sweep-zombies`. Sweep stale active runs into zombie terminal state (still functional)'
    )
    .option('--older-than <duration>', 'run inactivity threshold')
    .option('--dry-run', 'preview without mutating')
    .option('--yes', 'confirm mutation')
    .option('--json', 'output as JSON')
    .action(async (...actionArgs: unknown[]) => {
      const cmd = actionArgs[actionArgs.length - 1] as Command
      const rawArgv = rawArgvForVerb(cmd, 'sweep-zombies', { offset: 1, fallback: [] })
      await cmdRunSweepZombies(rawArgv, { deprecatedAlias: true })
    })

  run
    .command('reconcile-active')
    .description(
      'DEPRECATED: use `hrc admin runs reconcile-active`. Reconcile active runs whose runtime lifecycle is already terminal or idle (still functional)'
    )
    .option('--older-than <duration>', 'run inactivity threshold')
    .option('--dry-run', 'preview without mutating')
    .option('--yes', 'confirm mutation')
    .option('--json', 'output as JSON')
    .action(async (...actionArgs: unknown[]) => {
      const cmd = actionArgs[actionArgs.length - 1] as Command
      const rawArgv = rawArgvForVerb(cmd, 'reconcile-active', { offset: 1, fallback: [] })
      await cmdRunReconcileActive(rawArgv, { deprecatedAlias: true })
    })

  // -- resume (exact alias of `run`, T-04219 P2) -------------------------------
  // daedalus D4: `resume` shares run's handler, flags, and semantics. It is NOT
  // attach-only — it may start, reuse, or attach. Help text points at `attach` /
  // `run --attach-only` for the attach-only path.
  program
    .command('resume')
    .description('alias of `run`: start, reuse, or attach a managed runtime')
    .argument('[scope]', 'agent scope (agent, agent@project, or full scope ref)')
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .option('--force-restart', 'replace existing runtime with a fresh PTY')
    .option('--no-attach', 'start/ensure without attaching to the tmux session')
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
    .addHelpText(
      'after',
      `
Semantics:
  resume is an exact alias of \`hrc run\`. It may start a new runtime, reuse an
  existing one, or attach to a live one. It does NOT guarantee attach-only.
  For attach-only behavior use \`hrc attach <scope>\` or \`hrc run --attach-only\`.
`
    )
    .action(async (_scope, _opts, cmd: Command) => {
      const positionals: string[] = cmd.args
      const opts = cmd.opts()
      const rawArgv = rawArgvForVerb(cmd, 'resume', { offset: 1 })
      const args = toLegacyArgvForScopeCommand(positionals, opts, rawArgv, {
        strings: ['project-id', 'project-root', 'prompt-file'],
        booleans: ['force-restart', 'attach-only', 'dry-run', 'debug', 'json'],
        negatedBooleans: ['attach', 'register'],
      })
      await cmdRun(args, { invokedAs: 'resume' })
    })

  // -- admin group (T-04219 P2: run-RECORD repair, distinct from runtime sweep) -
  // daedalus D3: relocate run-record maintenance under `admin runs`. The old
  // `run sweep-zombies` / `run reconcile-active` aliases stay functional and emit
  // deprecation guidance to stderr.
  const admin = program.command('admin').description('administrative maintenance commands')
  const adminRuns = admin
    .command('runs')
    .description('repair run records (sweep zombies, reconcile active)')

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
      const rest = cmd.args.slice(1)
      await cmdLs(noun, rest)
    })

  // -- turn (alias for `hrcchat turn`) -----------------------------------------
  // All arguments are forwarded verbatim to `hrcchat turn`. This keeps `hrc turn`
  // in lockstep with `hrcchat turn` without duplicating its flag surface.

  program
    .command('turn')
    .description('alias for `hrcchat turn` — dispatch tracked work to an agent and stream progress')
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]', 'forwarded verbatim to `hrcchat turn`')
    .action(async (_args, _opts, cmd: Command) => {
      const forwarded = rawArgvForVerb(cmd, 'turn', { offset: 1, fallback: [] })
      await execHrcchatTurn(forwarded)
    })

  // -- inflight group (commander, Phase 6 T2) ---------------------------------

  const inflight = program.command('inflight').description('send in-flight runtime input')

  inflight
    .command('send')
    .description('send input to a run')
    .argument('<runtimeId>', 'runtime ID')
    .option('--run-id <id>', 'run ID')
    .option('--input <input>', 'input text')
    .option('--input-type <type>', 'input type')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: ['run-id', 'input', 'input-type'],
        booleans: [],
      })
      await cmdInflightSend(args)
    })

  // -- top-level commands (commander, Phase 6 T2b) -----------------------------

  program
    .command('capture')
    .description('capture live runtime output')
    .argument('[runtimeId]', 'runtime ID to capture')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const positionals = runtimeId !== undefined ? [runtimeId] : []
      const args = toLegacyArgv(positionals, cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdCapture(args)
    })

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

  // -- surface group (commander, Phase 6 T2) ----------------------------------

  const surface = program.command('surface').description('manage surface bindings')

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

  // -- bridge group (commander, Phase 6 T2) -----------------------------------

  const bridge = program.command('bridge').description('manage low-level local bridge delivery')

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
}
