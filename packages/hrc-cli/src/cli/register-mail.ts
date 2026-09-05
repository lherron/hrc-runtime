import type { Command } from 'commander'

import { cmdMailInspect } from '../mail-inspect.js'
import { annotateCommand } from './command-metadata.js'

/**
 * The mail group: read surfaces over the kicker's own rows (T-07964).
 *
 * It answers about an OBLIGATION, which is why it is not a `monitor` verb —
 * monitor's nouns are runtimes, sessions and turns, and its cursor grammars
 * belong to the event log. This joins the wrkq ledger row to HRC's drive
 * attempts, presentation receipts, reminders and failure notices, and it
 * never writes.
 */
export function registerMailCommands(program: Command): void {
  const mail = program
    .command('mail')
    .description('read surfaces over mail delivery and obligation disposal')
  annotateCommand(mail, { audience: 'both' })

  const inspect = mail
    .command('inspect')
    .description('explain what HRC did with an envelope, a scope, or a runtime')
    .argument('<target>', 'EN-xxxxx envelope id, target handle/session ref, or rt-<id>')
    .option('--json', 'output as JSON')
    .action(async (target: string, options: { json?: boolean | undefined }) => {
      await cmdMailInspect(target, { json: options.json })
    })
  annotateCommand(inspect, {
    audience: 'both',
    agentUsage: {
      example: 'hrc mail inspect EN-03687 --json',
      exitCodes: '0 on a rendered report (including an empty one); 1 on a store or usage failure',
      output:
        'One document: per-envelope ledger row, drive attempts, reminders, failure notices, timeline, and a one-line verdict.',
    },
  })
}
