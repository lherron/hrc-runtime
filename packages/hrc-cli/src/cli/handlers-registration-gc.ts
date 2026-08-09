import { createInterface } from 'node:readline/promises'

import type {
  ListRegistrationGcCandidatesResponse,
  RegistrationGcCandidate,
  RetireRegistrationScopesResponse,
} from 'hrc-core'

import { printJson } from '../print.js'
import { hasFlag } from './argv.js'
import { createClient, fatal } from './shared.js'

function printCandidatesHuman(report: ListRegistrationGcCandidatesResponse): void {
  process.stdout.write(
    `registration retirement candidates (${report.candidates.length}; linger=${report.lingerMs}ms)\n`
  )
  for (const candidate of report.candidates) {
    process.stdout.write(
      `  ${candidate.scopeRef}  registration=${candidate.registrationId} runtime=${candidate.runtimeId} status=${candidate.runtimeStatus} eligible=${candidate.eligibleAt}\n`
    )
  }
}

function printRetirementHuman(result: RetireRegistrationScopesResponse): void {
  process.stdout.write('registration retirement\n')
  for (const row of result.results) {
    process.stdout.write(
      `  ${row.status.padEnd(21)} ${row.scopeRef}${row.detail ? `  ${row.detail}` : ''}\n`
    )
  }
  process.stdout.write(
    `summary requested=${result.summary.requested} retired=${result.summary.retired} idempotent=${result.summary.idempotent} skipped=${result.summary.skipped} errors=${result.summary.errors}\n`
  )
}

async function confirmRetirement(candidates: readonly RegistrationGcCandidate[]): Promise<void> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    fatal('registration retirement confirmation requires a TTY; rerun with --yes to confirm')
  }
  process.stderr.write('The following placement authorities will be terminally retired:\n')
  for (const candidate of candidates) process.stderr.write(`  ${candidate.scopeRef}\n`)
  const readline = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await readline.question('Type "retire" to confirm: ')
    if (answer.trim().toLowerCase() !== 'retire') fatal('registration retirement aborted')
  } finally {
    readline.close()
  }
}

/**
 * No positional scopes means read-only list mode. Mutation is reachable only
 * through explicit exact scope arguments plus --yes or an interactive prompt.
 */
export async function cmdRegistrationsGc(args: string[]): Promise<void> {
  const yes = hasFlag(args, '--yes')
  const jsonOutput = hasFlag(args, '--json')
  const scopeRefs = args.filter((arg) => !arg.startsWith('-'))
  const client = createClient()
  const report = await client.listRegistrationGcCandidates()

  if (scopeRefs.length === 0) {
    if (yes) fatal('--yes requires at least one explicit registration scope')
    if (jsonOutput) printJson(report)
    else printCandidatesHuman(report)
    return
  }
  if (new Set(scopeRefs).size !== scopeRefs.length) {
    fatal('registration retirement scopes must be unique')
  }
  const byScope = new Map(report.candidates.map((candidate) => [candidate.scopeRef, candidate]))
  const selected = scopeRefs.map((scopeRef) => byScope.get(scopeRef))
  const missing = scopeRefs.filter((_scopeRef, index) => selected[index] === undefined)
  if (missing.length > 0) {
    fatal(`not current registration retirement candidates: ${missing.join(', ')}`)
  }
  const candidates = selected as RegistrationGcCandidate[]
  if (!yes) await confirmRetirement(candidates)

  const result = await client.retireRegistrationScopes({ scopeRefs })
  if (jsonOutput) printJson(result)
  else printRetirementHuman(result)
}
