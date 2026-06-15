import type { HrcDomainError } from 'hrc-core'
import { stringValue } from './stacked-shared.js'

const DETAIL_KEYS = ['runtimeId', 'runId', 'invocationId', 'activeRunId', 'route', 'flag', 'status']

export function formatHrcDomainError(err: HrcDomainError): string {
  const lines = [`[${err.code}] ${err.message}`]
  const reason = stringDetail(err, 'code')
  if (reason) {
    lines.push(`reason: ${reason}`)
  }

  const cause = detailCause(err)
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

  lines.push(...diagnosticLines(err))

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

function detailCause(err: HrcDomainError): string | undefined {
  return stringDetail(err, 'cause') ?? stringDetail(err, 'error') ?? stringDetail(err, 'message')
}

function diagnosticLines(err: HrcDomainError): string[] {
  const diagnostics = err.detail['diagnostics']
  if (!Array.isArray(diagnostics)) {
    return []
  }

  return diagnostics.flatMap((diagnostic) => {
    if (typeof diagnostic === 'string' && diagnostic.length > 0) {
      return [`diagnostic: ${diagnostic}`]
    }
    if (diagnostic === null || typeof diagnostic !== 'object') {
      return []
    }

    const record = diagnostic as Record<string, unknown>
    const level = stringValue(record['level']) ?? 'error'
    const profileId = stringValue(record['profileId'])
    const code = stringValue(record['code'])
    const message = stringValue(record['message'])
    const where = profileId ? ` [${profileId}]` : ''
    const codeSuffix = code ? ` ${code}` : ''
    const messageSuffix = message ? `: ${message}` : ''
    return [`diagnostic: ${level}${where}${codeSuffix}${messageSuffix}`]
  })
}
