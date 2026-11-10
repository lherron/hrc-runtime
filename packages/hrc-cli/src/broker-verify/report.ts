import type { VerificationCandidate } from 'hrc-capture-verifier'

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
