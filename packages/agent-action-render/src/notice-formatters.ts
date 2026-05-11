import { MAX_LINE_CHARS, truncateText } from './budgets.js'

export const NOTICE_ICON: Record<string, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
}

export function formatNoticeLine(level: string, message: string): string {
  const icon = NOTICE_ICON[level] ?? 'ℹ️'
  const prefix = `${icon} `
  return `${prefix}${truncateText(message, MAX_LINE_CHARS - prefix.length)}`
}
