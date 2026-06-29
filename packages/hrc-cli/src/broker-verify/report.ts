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
  if (report.transcriptArtifact !== undefined) {
    lines.push(
      `artifact: ${report.transcriptArtifact.artifactId}`,
      `artifact hash: ${report.transcriptArtifact.hashStatus} stored=${report.transcriptArtifact.storedHash}${report.transcriptArtifact.currentHash !== undefined ? ` current=${report.transcriptArtifact.currentHash}` : ''}`
    )
  }
  lines.push(...renderAnalyticsHuman(report), '')
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

function renderAnalyticsHuman(report: CaptureVerificationReport): string[] {
  const analytics = report.analytics
  const provider = analytics.providerJsonl
  const malformed = analytics.rawEvents.malformedEventJson + analytics.rawEvents.malformedPayload
  return [
    'analytics:',
    provider !== undefined
      ? `  provider JSONL: lines=${provider.totalLines} parsed=${provider.parsedRecords} applicable=${provider.applicableObservations} ignored=${provider.ignoredRecords} unsupported=${provider.unsupportedRecords} unknown=${provider.unknownRecords} warnings=${provider.warningCount}`
      : '  provider JSONL: not supplied',
    `  broker ledger: events=${analytics.brokerLedger.eventCount} applied=${analytics.rawEvents.appliedBrokerRows} seq=${analytics.brokerLedger.firstSeq ?? '-'}..${analytics.brokerLedger.lastSeq ?? '-'} holes=${analytics.brokerLedger.seqHoleCount} duplicates=${analytics.brokerLedger.duplicateSeqCount}`,
    `  raw events: matched=${analytics.rawEvents.matched}/${analytics.rawEvents.expectedFromBroker} missing=${analytics.rawEvents.missing} mismatched=${analytics.rawEvents.mismatched} malformed=${malformed}`,
    `  lifecycle: present=${analytics.lifecycleProjection.present} expected=${analytics.lifecycleProjection.expected} missing=${analytics.lifecycleProjection.missing} suppressed=${analytics.lifecycleProjection.suppressed} notApplicable=${analytics.lifecycleProjection.notApplicable} policy=${analytics.lifecycleProjection.policyId}@${analytics.lifecycleProjection.policyHash}`,
  ]
}
