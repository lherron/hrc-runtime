/**
 * Federation-facing commands: `hrc target locate` and `hrc doctor` (T-06613).
 *
 * `target` is a new top-level group. It reads as the noun an operator already
 * thinks in — the same noun `hrc` uses for a handle like `clod@hrc-runtime:T-1`
 * — and leaves room for the placement verbs that follow it (F1 peer locate,
 * F3 rebuild).
 */

import type { Command } from 'commander'

import { toLegacyArgv } from './argv.js'
import { cmdDoctor, cmdTargetBindings, cmdTargetLocate } from './handlers-federation.js'

export function registerFederationCommands(program: Command): void {
  const target = program.command('target').description('inspect where scopes live (placement)')

  target
    .command('locate')
    .argument('<scope>', 'scope ref or target handle (e.g. clod@hrc-runtime:T-06613)')
    .description('show declared policy, established binding, and observed runtimes for a scope')
    .option('--json', 'output as JSON')
    .option('--fail-on-skew', 'exit 1 when a pin disagrees with the established binding')
    .addHelpText(
      'after',
      [
        '',
        'Reports three independent truths, so a disagreement between them stays visible:',
        '  declared  what the agent profile [placement] stanza says',
        '  authority the established binding (local ledger first, then the registry)',
        '  observed  runtimes running on THIS node (peer observation is F1)',
        '',
        'SKEW is a pin disagreeing with an established binding. The established home',
        'keeps summon authority and the pin value is not acted on — editing a pin does',
        'not relocate a scope that already exists.',
        '',
        'An unpinned scope established away from default_home_node is EXPECTED, not skew:',
        'default_home_node routes implicit summons, it does not constrain where a scope lives.',
        '',
        'Exit codes:',
        '  0  reported (including when skew is present)',
        '  1  skew present and --fail-on-skew was passed',
        '  2  usage error',
      ].join('\n')
    )
    .action(async (scope: string, _opts, cmd: Command) => {
      await cmdTargetLocate(
        toLegacyArgv([scope], cmd.opts(), { strings: [], booleans: ['json', 'fail-on-skew'] })
      )
    })

  target
    .command('bindings')
    .description('list placement bindings on this node and any pin-vs-binding skew')
    .option('--json', 'output as JSON')
    .action(async (_opts, cmd: Command) => {
      await cmdTargetBindings(toLegacyArgv([], cmd.opts(), { strings: [], booleans: ['json'] }))
    })

  program
    .command('doctor')
    .description('check daemon health, node identity, and placement skew')
    .option('--json', 'output as JSON')
    .option('--strict', 'exit 1 on warnings as well as failures')
    .addHelpText(
      'after',
      [
        '',
        'Checks: hrc-daemon, node-identity, federation-config, placement-skew.',
        '',
        'Placement skew is reported as a WARNING, not a failure: a skewed binding is a',
        'live, correctly-serving scope whose declaration has drifted. Use --strict to',
        'exit nonzero on warnings.',
        '',
        'Exit codes:',
        '  0  no failing checks',
        '  1  a failing check (or any warning under --strict)',
      ].join('\n')
    )
    .action(async (_opts, cmd: Command) => {
      await cmdDoctor(toLegacyArgv([], cmd.opts(), { strings: [], booleans: ['json', 'strict'] }))
    })
}
