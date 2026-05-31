import { HrcDomainError } from 'hrc-core'

const DETAIL_KEYS = ['runtimeId', 'runId', 'invocationId', 'activeRunId', 'route', 'status']

export function formatHrcDomainError(err: HrcDomainError): string {
  const lines = [`[${err.code}] ${err.message}`]
  const cause = stringDetail(err, 'cause') ?? stringDetail(err, 'error')
  if (cause && !err.message.includes(cause)) {
    lines.push(`cause: ${cause}`)
  }

  const details = DETAIL_KEYS.flatMap((key) => {
    const value = err.detail[key]
    return typeof value === 'string' && value.length > 0 ? [`${key}=${value}`] : []
  })
  if (details.length > 0) {
    lines.push(`details: ${details.join(' ')}`)
  }

  const recommendation = stringDetail(err, 'recommendation')
  if (recommendation) {
    lines.push(`next: ${recommendation}`)
  }

  return lines.join('\n')
}

function stringDetail(err: HrcDomainError, key: string): string | undefined {
  const value = err.detail[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
