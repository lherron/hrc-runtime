import { truncateText } from './budgets.js'

export type MarkdownBlockStyle = 'tty' | 'plain' | 'markdown'

/** Minimum render width; narrower requests are clamped up to this floor. */
const MIN_BLOCK_WIDTH = 20

export type MarkdownBlockOptions = {
  width: number
  maxLines: number
  style: MarkdownBlockStyle
}

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line]
  const words = line.split(/(\s+)/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (word.length === 0) continue
    if (current.length + word.length <= width) {
      current += word
      continue
    }
    if (current.trim().length > 0) {
      lines.push(current.trimEnd())
      current = ''
    }
    if (word.length > width) {
      lines.push(truncateText(word, width, '…'))
    } else {
      current = word.trimStart()
    }
  }
  if (current.trim().length > 0) lines.push(current.trimEnd())
  return lines.length > 0 ? lines : ['']
}

function renderLine(line: string, style: MarkdownBlockStyle): string {
  if (style === 'markdown') return line
  if (line.startsWith('- ')) return `• ${line.slice(2)}`
  return line
}

export function renderMarkdownBlock(body: string, opts: MarkdownBlockOptions): string[] {
  const width = Math.max(MIN_BLOCK_WIDTH, opts.width)
  const out: string[] = []
  for (const rawLine of body.replace(/\r\n/g, '\n').split('\n')) {
    if (rawLine.trimStart().startsWith('```')) {
      out.push(rawLine)
      continue
    }
    const rendered = renderLine(rawLine, opts.style)
    out.push(...wrapLine(rendered, width))
  }

  if (out.length <= opts.maxLines) return out
  const visible = out.slice(0, Math.max(0, opts.maxLines - 1))
  visible.push(`… ${out.length - visible.length} more lines`)
  return visible
}
