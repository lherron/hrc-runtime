/** Shared primitives for monitor output renderers. */
import chalk from 'chalk'

export type PendingToolCall = {
  event: import('hrc-core').HrcLifecycleEvent
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

export type ParsedToolResult = {
  output: string
  stdout?: string | undefined
  stderr?: string | undefined
  exitCode?: number | undefined
  durationSeconds?: number | undefined
  interrupted?: boolean | undefined
  isError?: boolean | undefined
}

export function wrapBody(text: string, indent: string): string[] {
  if (!text) return []
  return text.split('\n').map((line) => `${indent}${line}`)
}

export function renderPrettyValue(value: unknown, indent: string): string[] {
  if (isInlinePrimitive(value)) return [`${indent}${formatInlineValue(value)}`]
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${chalk.dim('(empty)')}`]
    return value.flatMap((item, index) => [
      `${indent}${chalk.dim(`[${index}]`)}`,
      ...renderPrettyValue(item, `${indent}  `),
    ])
  }
  const record = asRecord(value)
  if (!record) return [`${indent}${chalk.dim(String(value))}`]
  const entries = Object.entries(record)
  if (entries.length === 0) return [`${indent}${chalk.dim('(empty)')}`]
  const width = Math.max(...entries.map(([key]) => key.length))
  return entries.flatMap(([key, child]) => {
    if (isInlinePrimitive(child)) {
      return [`${indent}| ${chalk.cyan(key.padEnd(width))} : ${formatInlineValue(child)}`]
    }
    return [`${indent}| ${chalk.cyan(key)}`, ...renderPrettyValue(child, `${indent}  `)]
  })
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text)
    return asRecord(parsed) ?? undefined
  } catch {
    return undefined
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function isInlinePrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

export function formatInlineValue(value: string | number | boolean | null): string {
  if (value === null) return chalk.dim('null')
  if (typeof value === 'boolean') return value ? chalk.green('true') : chalk.red('false')
  if (typeof value === 'number') return chalk.white(String(value))
  return chalk.white(value)
}

export function compactPath(path: string): string {
  const cwd = process.cwd()
  const home = process.env['HOME']
  let display = path
  if (path.startsWith(`${cwd}/`)) {
    display = path.slice(cwd.length + 1)
  } else if (home && path.startsWith(`${home}/`)) {
    display = `~/${path.slice(home.length + 1)}`
  }
  return truncateText(display, 80)
}

export function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}.` : value
}

export function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').length
}

export function millisToSeconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value / 1000
}
