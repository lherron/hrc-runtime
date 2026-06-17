import type { CaptureVerificationReport, VerificationCandidate } from 'hrc-capture-verifier'

export function renderCandidatesHuman(
  scopeRef: string,
  candidates: VerificationCandidate[]
): string {
  if (candidates.length === 0) {
    return `broker verify candidates ${scopeRef}\n\nNo broker invocations found for exact scope.\n`
  }
  const lines = [`broker verify candidates ${scopeRef}`, '']
  for (const candidate of candidates) {
    lines.push(
      [
        candidate.invocationId,
        candidate.brokerDriver,
        candidate.state,
        `events=${candidate.eventCount}`,
        `raw=${candidate.rawMirrorCount}`,
        `lifecycle=${candidate.lifecycleProjectionCount}`,
        `seq=${candidate.firstSeq ?? '-'}..${candidate.lastSeq ?? '-'}`,
        `runtime=${candidate.runtimeId}`,
        `transcript=${candidate.transcriptGuess?.confidence ?? 'unknown'}`,
      ].join('  ')
    )
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

export function renderReportHuman(report: CaptureVerificationReport): string {
  const lines = [
    `broker verify run ${report.invocationId}`,
    '',
    `status: ${report.status}`,
    `driver: ${report.brokerDriver}`,
    `runtime: ${report.runtimeId}`,
    `ledger: ${report.ledger.eventCount} event(s), seq ${report.ledger.firstSeq ?? '-'}..${report.ledger.lastSeq ?? '-'}`,
    `raw mirrors: ${report.rawMirror.matched}/${report.rawMirror.checked}`,
  ]
  if (report.transcriptPath !== undefined) {
    lines.push(
      `jsonl: ${report.transcriptPath}`,
      `provider events: ${report.transcript?.observations.length ?? 0}`
    )
  }
  const errors = report.findings.filter((issue) => issue.severity === 'error')
  const warnings = report.findings.filter((issue) => issue.severity === 'warning')
  lines.push(`issues: ${errors.length} error(s), ${warnings.length} warning(s)`, '')

  for (const issue of report.findings) {
    const loc =
      issue.line !== undefined
        ? `line ${issue.line}`
        : issue.brokerSeq !== undefined
          ? `seq ${issue.brokerSeq}`
          : undefined
    lines.push(
      `${issue.severity.toUpperCase()} ${issue.code}${loc !== undefined ? ` (${loc})` : ''}: ${issue.message}`
    )
  }
  if (report.findings.length === 0) {
    lines.push('No broker capture or projection integrity issues found.')
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
