import { formatNoticeLine, formatToolLine, renderMarkdownBlock } from 'agent-action-render'
import { Chalk } from 'chalk'
import type { RenderAction, RenderBlock, RenderFrame } from 'hrc-frame-render'

export type RenderFrameSinkFormat = 'terminal' | 'ndjson'
export type RenderFrameFormatInput = RenderFrameSinkFormat | 'tree' | 'compact' | 'json'

export interface ResolveRenderFrameSinkFormatOptions {
  format?: RenderFrameFormatInput | undefined
  isTTY?: boolean | undefined
}

export interface RenderFrameTerminalOptions {
  width?: number | undefined
  color?: boolean | undefined
  maxMarkdownLines?: number | undefined
  spinnerGlyph?: string | undefined
  elapsedLabel?: string | undefined
  scopeHandle?: string | undefined
  /** Used as the title when frame.title has no human content (e.g., empty inputContent). */
  titleFallback?: string | undefined
}

export interface WriteRenderFrameOptions extends RenderFrameTerminalOptions {
  stream?: Pick<NodeJS.WritableStream, 'write'> | undefined
}

export interface RenderFrameNdjsonEvent {
  type: 'render_frame'
  version: 1
  runId: string
  projectId: string
  phase: RenderFrame['phase']
  title?: string | undefined
  statusLine?: string | undefined
  updatedAt: number
  blocks: RenderBlock[]
  actions?: RenderAction[] | undefined
  persona?: RenderFrame['persona'] | undefined
}

const DEFAULT_TERMINAL_WIDTH = 96
const DEFAULT_MARKDOWN_LINES = 200
const MIN_TERMINAL_WIDTH = 48
const MAX_TERMINAL_WIDTH = 120
const MAX_TITLE_CHARS = 100
const BODY_INDENT = '  '
const ACTIVITY_PREFIX = '┊'
const ACTIVITY_INDENT = '   '
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const MAX_VISIBLE_ACTIVITY = 8
const MAX_TOOL_OUTPUT_LINES = 3
// Alternation rather than character class because ⚙️ is U+2699 + U+FE0F
// (variation selector), which a character class would split into two entries.
const PHASE_EMOJI_LEAD = /^(?:🔐|✅|❌|⚙️|⚙)+\s*/u

type Style = {
  bold: (value: string) => string
  dim: (value: string) => string
  accent: (value: string) => string
  done: (value: string) => string
  error: (value: string) => string
  permission: (value: string) => string
  rule: (value: string) => string
}

type ResolvedTerminalBlockOptions = {
  width: number
  maxMarkdownLines: number
}

function styleFor(color: boolean): Style {
  // Force level 3 (truecolor) when color is on; level 0 disables chalk entirely.
  const c = new Chalk({ level: color ? 3 : 0 })
  if (!color) {
    const id = (v: string) => v
    return { bold: id, dim: id, accent: id, done: id, error: id, permission: id, rule: id }
  }
  return {
    bold: (v) => c.bold(v),
    dim: (v) => c.dim(v),
    accent: (v) => c.rgb(217, 119, 6)(v),
    done: (v) => c.rgb(13, 148, 136)(v),
    error: (v) => c.rgb(185, 28, 28)(v),
    permission: (v) => c.rgb(202, 138, 4)(v),
    rule: (v) => c.rgb(87, 83, 78)(v),
  }
}

function terminalWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) {
    const cols = process.stdout?.columns
    if (cols && Number.isFinite(cols)) {
      return Math.max(MIN_TERMINAL_WIDTH, Math.min(MAX_TERMINAL_WIDTH, Math.floor(cols)))
    }
    return DEFAULT_TERMINAL_WIDTH
  }
  return Math.max(MIN_TERMINAL_WIDTH, Math.floor(width))
}

function truncateRunId(runId: string | undefined): string {
  if (!runId) return ''
  const cleaned = runId.replace(/^run-/, '')
  if (cleaned.length <= 12) return `run ${cleaned}`
  return `run ${cleaned.slice(0, 8)}…${cleaned.slice(-4)}`
}

function formatHeader(frame: RenderFrame, options: RenderFrameTerminalOptions): string {
  const parts: string[] = []
  if (options.scopeHandle) parts.push(options.scopeHandle)
  const runLabel = truncateRunId(frame.runId)
  if (runLabel) parts.push(runLabel)
  return parts.join(' · ')
}

function formatFooter(
  frame: RenderFrame,
  options: RenderFrameTerminalOptions,
  style: Style
): string {
  const parts: string[] = []
  if (options.elapsedLabel) parts.push(style.dim(options.elapsedLabel))
  if (frame.phase === 'final') parts.push(style.done('done'))
  else if (frame.phase === 'error') parts.push(style.error('error'))
  else if (frame.phase === 'permission') parts.push(style.permission('awaiting approval'))
  return parts.join(style.dim(' · '))
}

function glyphForPhase(
  phase: RenderFrame['phase'],
  spinnerGlyph: string | undefined,
  style: Style
): string {
  switch (phase) {
    case 'final':
      return style.done('✓')
    case 'error':
      return style.error('✗')
    case 'permission':
      return style.permission('🔐')
    default:
      return style.accent(spinnerGlyph ?? SPINNER_FRAMES[0] ?? '')
  }
}

function stripLeadingPhaseEmoji(title: string | undefined): string {
  if (!title) return ''
  return title.replace(PHASE_EMOJI_LEAD, '').trim()
}

function normalizeFallbackTitle(fallback: string | undefined): string {
  if (!fallback) return ''
  const oneLine = fallback.replace(/\s+/g, ' ').trim()
  if (oneLine.length === 0) return ''
  return oneLine.length > MAX_TITLE_CHARS ? `${oneLine.slice(0, MAX_TITLE_CHARS)}…` : oneLine
}

function truncateToolOutput(output: string): string {
  const lines = output.replace(/\r\n/g, '\n').split('\n')
  if (lines.length <= MAX_TOOL_OUTPUT_LINES) {
    return output.replace(/\s+$/, '')
  }
  const remaining = lines.length - MAX_TOOL_OUTPUT_LINES
  const suffix = `… ${remaining} more ${remaining === 1 ? 'line' : 'lines'}`
  return `${lines.slice(0, MAX_TOOL_OUTPUT_LINES).join('\n')}\n${suffix}`
}

function renderBlockLines(block: RenderBlock, options: ResolvedTerminalBlockOptions): string[] {
  const contentWidth = Math.max(
    MIN_TERMINAL_WIDTH - 6,
    options.width - BODY_INDENT.length - 2 - ACTIVITY_INDENT.length
  )

  switch (block.t) {
    case 'markdown':
      return renderMarkdownBlock(block.md, {
        width: contentWidth,
        maxLines: options.maxMarkdownLines,
        style: 'tty',
      })
    case 'code':
      return [`\`\`\`${block.lang ?? ''}`, ...block.code.replace(/\r\n/g, '\n').split('\n'), '```']
    case 'image':
      return ['[image attached]']
    case 'media_ref': {
      const label = block.filename ?? block.mimeType ?? 'media'
      return [`[media: ${label}]`]
    }
    case 'kv':
      return block.items.map((item) => `${item.k}: ${item.v}`)
    case 'progress_list':
      return block.items.map((item) => {
        const icon = item.state === 'running' ? '⏳' : item.state === 'done' ? '✓' : '✗'
        return `${icon} ${item.text}`
      })
    case 'tool': {
      const failed = block.approved === false
      const lines = [formatToolLine(block.toolName, block.input, block.summary, failed)]
      if (block.output) {
        const outputLines = truncateToolOutput(block.output).split('\n')
        outputLines.forEach((line, idx) => {
          lines.push(idx === 0 ? `↳ ${line}` : `  ${line}`)
        })
      }
      if (block.images && block.images.length > 0) {
        lines.push(`↳ ${block.images.length} image${block.images.length > 1 ? 's' : ''} attached`)
      }
      if (block.approvalSource) {
        lines.push(`↳ allowed by ${block.approvalSource}`)
      }
      return lines
    }
    case 'notice':
      return [formatNoticeLine(block.level, block.message)]
  }
}

function partitionAnswerBlocks(blocks: readonly RenderBlock[]): {
  activity: RenderBlock[]
  answerMarkdown: string | undefined
} {
  if (blocks.length === 0) return { activity: [], answerMarkdown: undefined }

  let lastActivityIndex = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block && block.t !== 'markdown') {
      lastActivityIndex = i
      break
    }
  }

  if (lastActivityIndex === -1) {
    const md = blocks
      .filter((b): b is Extract<RenderBlock, { t: 'markdown' }> => b.t === 'markdown')
      .map((b) => b.md)
      .filter((s) => s.trim().length > 0)
      .join('\n\n')
    return { activity: [], answerMarkdown: md.length > 0 ? md : undefined }
  }

  const activity = blocks.slice(0, lastActivityIndex + 1)
  const trailing = blocks.slice(lastActivityIndex + 1)
  const md = trailing
    .filter((b): b is Extract<RenderBlock, { t: 'markdown' }> => b.t === 'markdown')
    .map((b) => b.md)
    .filter((s) => s.trim().length > 0)
    .join('\n\n')
  return { activity: [...activity], answerMarkdown: md.length > 0 ? md : undefined }
}

function renderActivityBlock(
  block: RenderBlock,
  style: Style,
  blockOpts: ResolvedTerminalBlockOptions,
  active: boolean
): string[] {
  // Active phases keep activity at full brightness with an accent rail —
  // that's where the user's attention belongs while the turn is still
  // unfolding. Once the turn is final/error, activity recedes to dim so the
  // answer is the protagonist.
  const rail = active ? style.accent(ACTIVITY_PREFIX) : style.dim(ACTIVITY_PREFIX)
  const tint = active ? (v: string) => v : style.dim
  const blockLines = renderBlockLines(block, blockOpts)
  if (blockLines.length === 0) return []
  const [first, ...rest] = blockLines
  const out: string[] = []
  out.push(`${BODY_INDENT}${rail} ${tint(first ?? '')}`)
  for (const line of rest) {
    out.push(`${BODY_INDENT}${rail}${ACTIVITY_INDENT}${style.dim(line)}`)
  }
  return out
}

function renderPermissionActions(actions: readonly RenderAction[], style: Style): string[] {
  if (actions.length === 0) return []
  const out: string[] = []
  out.push(`${BODY_INDENT}${style.permission(style.bold('approval required'))}`)
  for (const action of actions) {
    out.push(
      `${BODY_INDENT}${style.permission('·')} ${style.bold(action.label)} ${style.dim(`(${action.id})`)}`
    )
  }
  return out
}

export function renderFrameToTerminalText(
  frame: RenderFrame,
  options: RenderFrameTerminalOptions = {}
): string {
  const width = terminalWidth(options.width)
  const maxMarkdownLines = options.maxMarkdownLines ?? DEFAULT_MARKDOWN_LINES
  const style = styleFor(options.color ?? false)
  const lines: string[] = []
  const blockOpts: ResolvedTerminalBlockOptions = { width, maxMarkdownLines }

  // ── Header label (editorial — no rule glyph) ─────────────────────────
  const headerLabel = formatHeader(frame, options)
  if (headerLabel) {
    lines.push(`${BODY_INDENT}${style.dim(headerLabel)}`)
  }
  lines.push('')

  // ── Title row ────────────────────────────────────────────────────────
  const glyph = glyphForPhase(frame.phase, options.spinnerGlyph, style)
  const titleText =
    stripLeadingPhaseEmoji(frame.title) || normalizeFallbackTitle(options.titleFallback)
  if (titleText) {
    lines.push(`${BODY_INDENT}${glyph}  ${style.bold(titleText)}`)
  } else {
    lines.push(`${BODY_INDENT}${glyph}`)
  }
  // Status line only when it adds signal: permission/error phases.
  // For queued/running/final, the spinner glyph + footer already say it.
  const showStatus =
    frame.statusLine !== undefined && (frame.phase === 'permission' || frame.phase === 'error')
  if (showStatus) {
    lines.push(`${BODY_INDENT}${style.dim('·')}  ${style.dim(frame.statusLine ?? '')}`)
  }
  lines.push('')

  // ── Permission actions (if any) ──────────────────────────────────────
  if (frame.phase === 'permission' && frame.actions && frame.actions.length > 0) {
    for (const line of renderPermissionActions(frame.actions, style)) lines.push(line)
    lines.push('')
  }

  // ── Activity blocks vs answer ────────────────────────────────────────
  const { activity, answerMarkdown } = partitionAnswerBlocks(frame.blocks)

  const skip = Math.max(0, activity.length - MAX_VISIBLE_ACTIVITY)
  if (skip > 0) {
    lines.push(`${BODY_INDENT}${style.dim(`… ${skip} earlier step${skip > 1 ? 's' : ''}`)}`)
    lines.push('')
  }
  const visible = activity.slice(skip)
  const active =
    frame.phase === 'queued' || frame.phase === 'progress' || frame.phase === 'permission'
  for (const block of visible) {
    for (const line of renderActivityBlock(block, style, blockOpts, active)) lines.push(line)
    lines.push('')
  }

  // ── Final answer (protagonist treatment — no tree prefix) ────────────
  if (answerMarkdown) {
    const contentWidth = Math.max(
      MIN_TERMINAL_WIDTH - BODY_INDENT.length,
      width - BODY_INDENT.length
    )
    const md = renderMarkdownBlock(answerMarkdown, {
      width: contentWidth,
      maxLines: maxMarkdownLines,
      style: 'tty',
    })
    // Thin separator above the answer when there was preceding activity, so
    // the answer reads as its own beat.
    if (activity.length > 0) {
      lines.push(`${BODY_INDENT}${style.rule('─'.repeat(12))}`)
    }
    for (const line of md) {
      lines.push(`${BODY_INDENT}${style.bold(line)}`)
    }
    lines.push('')
  }

  // ── Footer ───────────────────────────────────────────────────────────
  // Indented dim text, color-coded status word — no full-width rule.
  const footerLabel = formatFooter(frame, options, style)
  if (footerLabel) {
    lines.push(`${BODY_INDENT}${footerLabel}`)
  }

  return `${lines.join('\n')}\n`
}

export function renderFrameToNdjsonEvent(frame: RenderFrame): RenderFrameNdjsonEvent {
  return {
    type: 'render_frame',
    version: 1,
    runId: frame.runId,
    projectId: frame.projectId,
    phase: frame.phase,
    title: frame.title,
    statusLine: frame.statusLine,
    updatedAt: frame.updatedAt,
    blocks: frame.blocks,
    actions: frame.actions,
    persona: frame.persona,
  }
}

export function renderFrameToNdjsonLine(frame: RenderFrame): string {
  return `${JSON.stringify(renderFrameToNdjsonEvent(frame))}\n`
}

export function writeRenderFrameToTerminal(
  frame: RenderFrame,
  options: WriteRenderFrameOptions = {}
): void {
  const stream = options.stream ?? process.stdout
  const streamIsTTY = stream === process.stdout ? process.stdout.isTTY === true : false
  stream.write(
    renderFrameToTerminalText(frame, { ...options, color: options.color ?? streamIsTTY })
  )
}

export interface TerminalFrameRendererOptions extends RenderFrameTerminalOptions {
  stream?: NodeJS.WritableStream | undefined
  inPlace?: boolean | undefined
  startTime?: number | undefined
  /**
   * Override now() — useful for deterministic tests. Defaults to Date.now.
   */
  now?: (() => number) | undefined
}

export interface TerminalFrameRenderer {
  write(frame: RenderFrame, perCall?: RenderFrameTerminalOptions): void
}

/**
 * Stateful renderer. On a TTY it redraws the frame in place via ANSI cursor
 * codes; on a non-TTY (or when inPlace is explicitly false) it appends —
 * safe for piped capture. Cycles a Braille spinner and tracks elapsed time.
 */
export function createTerminalFrameRenderer(
  options: TerminalFrameRendererOptions = {}
): TerminalFrameRenderer {
  const stream = options.stream ?? process.stdout
  const streamIsStdout = stream === process.stdout
  const defaultInPlace = streamIsStdout && process.stdout.isTTY === true
  const inPlace = options.inPlace ?? defaultInPlace
  const baseColor = options.color ?? defaultInPlace
  const now = options.now ?? (() => Date.now())
  const startTime = options.startTime ?? now()
  const baseOpts: RenderFrameTerminalOptions = {
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.maxMarkdownLines !== undefined
      ? { maxMarkdownLines: options.maxMarkdownLines }
      : {}),
    ...(options.scopeHandle !== undefined ? { scopeHandle: options.scopeHandle } : {}),
    ...(options.titleFallback !== undefined ? { titleFallback: options.titleFallback } : {}),
    color: baseColor,
  }
  let prevLineCount = 0
  let frameIndex = 0

  function spinner(): string {
    return SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? ''
  }

  function elapsedLabel(): string {
    const ms = Math.max(0, now() - startTime)
    if (ms < 1000) return `${ms}ms`
    const s = ms / 1000
    if (s < 10) return `${s.toFixed(1)}s`
    if (s < 60) return `${Math.round(s)}s`
    const m = Math.floor(s / 60)
    const rem = Math.round(s - m * 60)
    return `${m}m${rem}s`
  }

  return {
    write(frame: RenderFrame, perCall?: RenderFrameTerminalOptions): void {
      const merged: RenderFrameTerminalOptions = {
        ...baseOpts,
        spinnerGlyph: spinner(),
        elapsedLabel: elapsedLabel(),
        ...(perCall ?? {}),
      }
      const text = renderFrameToTerminalText(frame, merged)
      if (inPlace && prevLineCount > 0) {
        stream.write(`\x1b[${prevLineCount}A\x1b[J`)
      }
      stream.write(text)
      const newlineCount = (text.match(/\n/g) ?? []).length
      prevLineCount = newlineCount
      frameIndex++
    },
  }
}

export function writeRenderFrameAsNdjson(
  frame: RenderFrame,
  options: Pick<WriteRenderFrameOptions, 'stream'> = {}
): void {
  const stream = options.stream ?? process.stdout
  stream.write(renderFrameToNdjsonLine(frame))
}

export function resolveRenderFrameSinkFormat(
  options: ResolveRenderFrameSinkFormatOptions = {}
): RenderFrameSinkFormat {
  switch (options.format) {
    case 'terminal':
    case 'tree':
    case 'compact':
      return 'terminal'
    case 'ndjson':
    case 'json':
      return 'ndjson'
    case undefined:
      return options.isTTY === true ? 'terminal' : 'ndjson'
    default: {
      const _exhaustive: never = options.format
      throw new Error(`Unsupported render frame format: ${_exhaustive}`)
    }
  }
}
