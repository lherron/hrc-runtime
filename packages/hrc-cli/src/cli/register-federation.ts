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
import {
  cmdDoctor,
  cmdFederationOutboxDrop,
  cmdFederationOutboxList,
  cmdFederationOutboxReplay,
  cmdTargetBindings,
  cmdTargetLocate,
} from './handlers-federation.js'

export function registerFederationCommands(program: Command): void {
  const federation = program.command('federation').description('inspect and operate federation')
  const outbox = federation
    .command('outbox')
    .description('inspect, replay, and drop durable origin deliveries')

  outbox
    .command('list')
    .description('list pending and dead-letter deliveries grouped by peer')
    .option('--peer <node>', 'filter by destination node')
    .option(
      '--state <csv>',
      'filter states (pending,retry_scheduled,peer_unreachable,delivered,dead_letter)'
    )
    .option('--json', 'output full delivery records as JSON')
    .action(async (_opts, cmd: Command) => {
      await cmdFederationOutboxList(
        toLegacyArgv([], cmd.opts(), { strings: ['peer', 'state'], booleans: ['json'] })
      )
    })

  outbox
    .command('replay')
    .argument('[delivery-id]', 'one dead-letter delivery id')
    .description('replay one dead-letter, or every dead-letter for one peer')
    .option('--peer <node>', 'destination node (required with --all)')
    .option('--all', 'replay every dead-letter for --peer')
    .option('--json', 'output replayed delivery records as JSON')
    .action(async (deliveryId: string | undefined, _opts, cmd: Command) => {
      await cmdFederationOutboxReplay(
        toLegacyArgv(deliveryId === undefined ? [] : [deliveryId], cmd.opts(), {
          strings: ['peer'],
          booleans: ['all', 'json'],
        })
      )
    })

  outbox
    .command('drop')
    .argument('<delivery-id>', 'terminal dead-letter delivery id')
    .description('permanently delete one dead-letter delivery')
    .option('--yes', 'confirm permanent deletion')
    .option('--json', 'output the deleted delivery record as JSON')
    .action(async (deliveryId: string, _opts, cmd: Command) => {
      await cmdFederationOutboxDrop(
        toLegacyArgv([deliveryId], cmd.opts(), { strings: [], booleans: ['yes', 'json'] })
      )
    })

  const target = program.command('target').description('inspect where scopes live (placement)')

  target
    .command('locate')
    .argument('<scope>', 'scope ref or target handle (e.g. clod@hrc-runtime:T-06613)')
    .description('show declared policy, established binding, and observed runtimes for a scope')
    .option('--json', 'output as JSON')
    .option('--fail-on-skew', 'exit 1 when placement disagrees with the established binding')
    .addHelpText(
      'after',
      [
        '',
        'Reports three independent truths, so a disagreement between them stays visible:',
        '  declared  what the agent profile [placement] stanza says',
        '  authority the established binding (local ledger first, then the registry)',
        '  observed  runtimes running on THIS node (peer observation is F1)',
        '',
        'SKEW is an exact pin or matched task-default disagreeing with an established',
        'binding. The established home keeps summon authority and the policy edit is',
        'not acted on — editing placement does not relocate a scope that already exists.',
        '',
        'An unconstrained scope established away from default_home_node is EXPECTED, not skew:',
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
        'Checks: hrc-daemon, node-identity, federation-config, placement-skew, federation-outbox.',
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
