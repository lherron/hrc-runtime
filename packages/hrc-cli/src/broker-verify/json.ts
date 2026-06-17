import { createHash } from 'node:crypto'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key])
    }
    return out
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return undefined
  }
  const parts: string[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const type = item['type']
    const text = item['text']
    if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof text === 'string') {
      parts.push(text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('')
}

export function compactText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.replace(/\s+/g, ' ').trim()
}
