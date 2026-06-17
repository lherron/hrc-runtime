import type { BrokerVerifyCandidate, BrokerVerifyReport } from './types.js'

export function renderCandidatesHuman(scopeRef: string, candidates: BrokerVerifyCandidate[]): string {
  if (candidates.length === 0) {
    return `broker verify candidates ${scopeRef}\n\nNo broker invocations found for exact scope.\n`
  }
  const lines = [`broker verify candidates ${scopeRef}`, '']
  for (const candidate of candidates) {
    lines.push(
      [
        candidate.invocationId,
        candidate.brokerDriver,
        candidate.invocationState,
        `events=${candidate.eventCount}`,
        `seq=${candidate.firstSeq ?? '-'}..${candidate.lastSeq ?? '-'}`,
        `runtime=${candidate.runtimeId}`,
        `confidence=${candidate.confidence}`,
      ].join('  ')
    )
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

export function renderReportHuman(report: BrokerVerifyReport): string {
  const lines = [
    `broker verify run ${report.invocationId}`,
    '',
    `status: ${report.ok ? 'ok' : 'failed'}`,
    `driver: ${report.brokerDriver}`,
    `runtime: ${report.runtimeId}`,
    `ledger: ${report.ledger.eventCount} event(s), seq ${report.ledger.firstSeq ?? '-'}..${report.ledger.lastSeq ?? '-'}`,
    `raw mirrors: ${report.rawMirror.matched}/${report.rawMirror.checked}`,
  ]
  if (report.jsonlPath !== undefined) {
    lines.push(
      `jsonl: ${report.jsonlPath}`,
      `provider events: ${report.transcript?.observed.length ?? 0}`
    )
  }
  const errors = report.issues.filter((issue) => issue.severity === 'error')
  const warnings = report.issues.filter((issue) => issue.severity === 'warning')
  lines.push(`issues: ${errors.length} error(s), ${warnings.length} warning(s)`, '')

  for (const issue of report.issues) {
    const loc =
      issue.line !== undefined
        ? `line ${issue.line}`
        : issue.seq !== undefined
          ? `seq ${issue.seq}`
          : undefined
    lines.push(
      `${issue.severity.toUpperCase()} ${issue.code}${loc !== undefined ? ` (${loc})` : ''}: ${issue.message}`
    )
  }
  if (report.issues.length === 0) {
    lines.push('No broker capture or projection integrity issues found.')
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
