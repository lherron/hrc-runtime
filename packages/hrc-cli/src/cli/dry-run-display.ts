/**
 * T-08596 (T-08569A closure) — HRC-owned terminal display formatting for the
 * daemon-backed `--dry-run` preview, vendored from the spaces-execution
 * prompt-display helpers it replaces (display-only: framing, elision,
 * shell-quoting; no interpretation — the plan facts and prompt zones arrive
 * already compiled from the daemon's `POST /v1/previews/run`).
 */
import chalk from 'chalk'

export type PromptSection = {
  title: string
  content: string
  color: (text: string) => string
  sectionSizes?: string[] | undefined
}

export type PromptBudget = {
  promptChars: number
  reminderChars: number
  totalChars: number
  maxChars?: number | undefined
  nearMaxChars?: boolean | undefined
}

export type DisplayPromptOptions = {
  systemPrompt?: string | undefined
  systemPromptMode?: 'replace' | 'append' | undefined
  reminderContent?: string | undefined
  primingPrompt?: string | undefined
  promptSectionSizes?: string[] | undefined
  reminderSectionSizes?: string[] | undefined
  totalContextChars?: number | undefined
  maxChars?: number | undefined
  nearMaxChars?: boolean | undefined
  command?: string | undefined
  showCommand?: boolean | undefined
  headerLines?: string[] | undefined
  betweenLines?: string[] | undefined
}

const FRAME_WIDTH = 72
const PROMPT_FLAGS = new Set(['--system-prompt', '--append-system-prompt'])
const LONG_ARG_THRESHOLD = 200
const SECTION_SEPARATOR = '\n\n---\n\n'

export function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function decodeContentEnvelope(section: string): string | undefined {
  const trimmed = section.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== 'content') return undefined
  const content = (parsed as { content: unknown }).content
  return typeof content === 'string' ? content : undefined
}

export function decodeForDisplay(content: string): string {
  return content
    .split(SECTION_SEPARATOR)
    .map((section) => decodeContentEnvelope(section) ?? section)
    .join(SECTION_SEPARATOR)
}

export function renderSection(section: PromptSection): string[] {
  const { title, content, color, sectionSizes } = section
  const chars = content.length
  const displayContent = decodeForDisplay(content)
  const lines: string[] = []
  const titleSegment = `─ ${title} `
  const remainingWidth = Math.max(0, FRAME_WIDTH - titleSegment.length - 1)
  const topRule = '─'.repeat(remainingWidth)
  lines.push(color(`┌${titleSegment}`) + chalk.dim(topRule))
  lines.push(chalk.dim('│'))
  for (const line of displayContent.split('\n')) {
    lines.push(chalk.dim('│  ') + line)
  }
  lines.push(chalk.dim('│'))
  const meta = [`${chars.toLocaleString()} chars`]
  if (sectionSizes && sectionSizes.length > 0) {
    meta.push(sectionSizes.join(', '))
  }
  const metaStr = meta.join(' · ')
  const metaSegment = ` ${metaStr}`
  const bottomWidth = Math.max(0, FRAME_WIDTH - metaSegment.length - 1)
  const bottomRule = '─'.repeat(bottomWidth)
  lines.push(chalk.dim(`└${bottomRule}`) + chalk.dim(metaSegment))
  return lines
}

export function formatDisplayCommand(commandPath: string, args: string[]): string {
  const parts = [shellQuote(commandPath)]
  let pastSeparator = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '--') {
      pastSeparator = true
      parts.push(arg)
      continue
    }
    if (PROMPT_FLAGS.has(arg) && i + 1 < args.length) {
      const value = args[i + 1]
      if (value === undefined) continue
      parts.push(shellQuote(arg))
      parts.push(`'<${value.length.toLocaleString()} chars>'`)
      i++
    } else if (pastSeparator && arg.length > LONG_ARG_THRESHOLD) {
      parts.push(`'<${arg.length.toLocaleString()} chars>'`)
    } else {
      parts.push(shellQuote(arg))
    }
  }
  return parts.join(' ')
}

export function renderKeyValueSection(
  title: string,
  entries: Array<[string, string]>,
  color: (text: string) => string = chalk.cyan
): string[] {
  if (entries.length === 0) return []
  const lines: string[] = []
  lines.push(color(`── ${title} ──`))
  const keyWidth = Math.max(...entries.map(([k]) => k.length))
  for (const [k, v] of entries) {
    lines.push(chalk.dim(`  ${k.padEnd(keyWidth)}  `) + v)
  }
  return lines
}

function renderBudget(budget: PromptBudget): string[] {
  const lines = ['']
  if (budget.maxChars !== undefined) {
    const pct = Math.round((budget.totalChars / budget.maxChars) * 100)
    lines.push(
      chalk.dim(
        `  Budget: ${budget.totalChars.toLocaleString()}/${budget.maxChars.toLocaleString()} chars (${pct}%)`
      )
    )
    if (budget.nearMaxChars) {
      lines.push(chalk.yellow('  ⚠ Approaching max_chars budget'))
    }
  } else {
    const parts = [
      `prompt: ${budget.promptChars.toLocaleString()}`,
      `reminder: ${budget.reminderChars.toLocaleString()}`,
    ]
    lines.push(
      chalk.dim(
        `  Total context: ${budget.totalChars.toLocaleString()} chars (${parts.join(', ')})`
      )
    )
  }
  return lines
}

export async function displayPrompts(opts: DisplayPromptOptions): Promise<void> {
  const hasPrompt = !!opts.systemPrompt
  const hasReminder = !!opts.reminderContent
  const hasPriming = !!opts.primingPrompt
  const hasCommand = !!(opts.showCommand && opts.command)
  const hasHeader = !!(opts.headerLines && opts.headerLines.length > 0)
  const hasBetween = !!(opts.betweenLines && opts.betweenLines.length > 0)
  if (!hasPrompt && !hasReminder && !hasPriming && !hasCommand && !hasHeader && !hasBetween) {
    return
  }
  const allLines: string[] = []
  const summary: string[] = []
  if (hasHeader) {
    allLines.push(...(opts.headerLines ?? []))
  }
  if (hasPrompt) {
    allLines.push('')
    allLines.push(
      ...renderSection({
        title:
          opts.systemPromptMode === 'append' ? 'System Prompt (append)' : 'System Prompt (replace)',
        content: opts.systemPrompt ?? '',
        color: chalk.cyan,
        sectionSizes: opts.promptSectionSizes,
      })
    )
    summary.push(`system: ${opts.systemPrompt?.length.toLocaleString()}`)
  }
  if (hasReminder) {
    allLines.push('')
    allLines.push(
      ...renderSection({
        title: 'Session Reminder',
        content: opts.reminderContent ?? '',
        color: chalk.yellow,
        sectionSizes: opts.reminderSectionSizes,
      })
    )
    summary.push(`reminder: ${opts.reminderContent?.length.toLocaleString()}`)
  }
  if (hasPrompt || hasReminder) {
    const promptChars = opts.systemPrompt?.length ?? 0
    const reminderChars = opts.reminderContent?.length ?? 0
    const totalChars = opts.totalContextChars ?? promptChars + reminderChars
    allLines.push(
      ...renderBudget({
        promptChars,
        reminderChars,
        totalChars,
        maxChars: opts.maxChars,
        nearMaxChars: opts.nearMaxChars,
      })
    )
  }
  if (hasPriming) {
    allLines.push('')
    allLines.push(
      ...renderSection({
        title: 'Priming Prompt',
        content: opts.primingPrompt ?? '',
        color: chalk.green,
      })
    )
    summary.push(`priming: ${opts.primingPrompt?.length.toLocaleString()}`)
  }
  if (summary.length > 0) {
    const totalChars =
      (opts.systemPrompt?.length ?? 0) +
      (opts.reminderContent?.length ?? 0) +
      (opts.primingPrompt?.length ?? 0)
    allLines.push('')
    allLines.push(
      chalk.dim(`  Total: ${totalChars.toLocaleString()} chars (${summary.join(', ')})`)
    )
  }
  if (hasBetween) {
    allLines.push('')
    allLines.push(...(opts.betweenLines ?? []))
  }
  if (hasCommand) {
    allLines.push('')
    allLines.push(chalk.cyan('── command ──'))
    allLines.push(opts.command ?? '')
  }
  for (const line of allLines) {
    process.stdout.write(`${line}\n`)
  }
}
