import type { HrcMailEnvelope } from 'hrc-core'

function schemaLabel(envelope: HrcMailEnvelope): string {
  return envelope.replySchema === undefined ? 'none' : JSON.stringify(envelope.replySchema)
}

export function renderEnvelopeSummary(envelope: HrcMailEnvelope): string {
  return [
    `${envelope.envelopeId}  ${envelope.state}  ${envelope.payload.kind}`,
    `  from: ${envelope.from.kind === 'scope' ? envelope.from.sessionRef : envelope.from.principal}`,
    `  body: ${envelope.payload.body.split('\n')[0]?.slice(0, 160) ?? ''}`,
    `  reply-schema: ${schemaLabel(envelope)}`,
  ].join('\n')
}

export function renderEnvelopeDetail(envelope: HrcMailEnvelope): string {
  const lines = [
    `id: ${envelope.envelopeId}`,
    `ingress: ${envelope.ingressId}`,
    `state: ${envelope.state}`,
    `target: ${envelope.targetSessionRef}`,
    `from: ${envelope.from.kind === 'scope' ? envelope.from.sessionRef : envelope.from.principal}`,
    `kind: ${envelope.payload.kind}`,
    `rounds: ${envelope.roundCount}`,
    `created: ${envelope.createdAt}`,
  ]
  if (envelope.retryAt) lines.push(`retry-at: ${envelope.retryAt}`)
  if (envelope.deferReason) lines.push(`defer-reason: ${envelope.deferReason}`)
  lines.push(`reply-schema: ${schemaLabel(envelope)}`)
  if (Object.hasOwn(envelope, 'response')) {
    lines.push(`response: ${JSON.stringify(envelope.response)}`)
  }
  lines.push('', envelope.payload.body)
  return lines.join('\n')
}
