import { formatNoticeLine, formatToolLine, renderMarkdownBlock } from 'agent-action-render'
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

const DEFAULT_TERMINAL_WIDTH = 100
const DEFAULT_MARKDOWN_LINES = 200
const MIN_TERMINAL_WIDTH = 40
const TREE_PREFIX_WIDTH = 3

type Style = {
  bold: (value: string) => string
  dim: (value: string) => string
  red: (value: string) => string
  yellow: (value: string) => string
}

type ResolvedTerminalBlockOptions = {
  width: number
  maxMarkdownLines: number
}

function styleFor(color: boolean): Style {
  const wrap = (open: string, close: string) => (value: string) =>
    color ? `${open}${value}${close}` : value

  return {
    bold: wrap('\u001b[1m', '\u001b[22m'),
    dim: wrap('\u001b[2m', '\u001b[22m'),
    red: wrap('\u001b[31m', '\u001b[39m'),
    yellow: wrap('\u001b[33m', '\u001b[39m'),
  }
}

function terminalWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) {
    return DEFAULT_TERMINAL_WIDTH
  }
  return Math.max(MIN_TERMINAL_WIDTH, Math.floor(width))
}

function treeLine(lines: string[], text: string, last: boolean): string {
  const prefix = last ? '└─ ' : '├─ '
  lines.push(`${prefix}${text}`)
  return last ? '   ' : '│  '
}

function childLines(lines: string[], prefix: string, values: readonly string[]): void {
  for (const value of values) {
    lines.push(`${prefix}${value}`)
  }
}

function codeLines(code: string, lang: string | undefined): string[] {
  return [`\`\`\`${lang ?? ''}`, ...code.replace(/\r\n/g, '\n').split('\n'), '```']
}

function truncateToolOutput(output: string): string {
  const lines = output.split('\n')
  const maxLines = 3
  if (lines.length <= maxLines) {
    return output
  }
  return `${lines.slice(0, maxLines).join('\n')}\n... (${lines.length - maxLines} more lines)`
}

function renderBlockLines(block: RenderBlock, options: ResolvedTerminalBlockOptions): string[] {
  const contentWidth = Math.max(
    MIN_TERMINAL_WIDTH - TREE_PREFIX_WIDTH,
    options.width - TREE_PREFIX_WIDTH
  )

  switch (block.t) {
    case 'markdown':
      return renderMarkdownBlock(block.md, {
        width: contentWidth,
        maxLines: options.maxMarkdownLines,
        style: 'tty',
      })
    case 'code':
      return codeLines(block.code, block.lang)
    case 'image':
      return ['_[Image attached]_']
    case 'media_ref': {
      const label = block.filename ?? block.mimeType ?? 'media'
      return [`_[Media attached: ${label.replace(/_/g, '\\_')}]_`]
    }
    case 'kv':
      return block.items.map((item) => `${item.k}: ${item.v}`)
    case 'progress_list':
      return block.items.map((item) => {
        const icon = item.state === 'running' ? '⏳' : item.state === 'done' ? '✅' : '❌'
        return `${icon} ${item.text}`
      })
    case 'tool': {
      const failed = block.approved === false
      const lines = [formatToolLine(block.toolName, block.input, block.summary, failed)]
      if (block.output) {
        lines.push(...codeLines(truncateToolOutput(block.output), undefined))
      }
      if (block.images && block.images.length > 0) {
        lines.push(`_[${block.images.length} image${block.images.length > 1 ? 's' : ''} attached]_`)
      }
      if (block.approvalSource) {
        lines.push(`_Allowed by ${block.approvalSource}_`)
      }
      return lines
    }
    case 'notice':
      return [formatNoticeLine(block.level, block.message)]
  }
}

function renderActions(actions: readonly RenderAction[]): string[] {
  if (actions.length === 0) {
    return []
  }
  return [
    'Actions:',
    ...actions.map((action) => `- ${action.kind}: ${action.label} (${action.id})`),
  ]
}

export function renderFrameToTerminalText(
  frame: RenderFrame,
  options: RenderFrameTerminalOptions = {}
): string {
  const width = terminalWidth(options.width)
  const maxMarkdownLines = options.maxMarkdownLines ?? DEFAULT_MARKDOWN_LINES
  const style = styleFor(options.color ?? false)
  const lines: string[] = []

  if (frame.phase === 'permission') {
    lines.push(style.yellow(style.bold('APPROVAL REQUIRED')))
  }
  if (frame.title) {
    lines.push(style.bold(frame.title))
  }
  if (frame.statusLine) {
    lines.push(style.dim(frame.statusLine))
  }

  const actionLines = frame.phase === 'permission' ? renderActions(frame.actions ?? []) : []
  const renderedBlocks = frame.blocks.map((block) =>
    renderBlockLines(block, { width, maxMarkdownLines })
  )
  const totalNodes = renderedBlocks.length + (actionLines.length > 0 ? 1 : 0)

  renderedBlocks.forEach((blockLines, index) => {
    const last = index === totalNodes - 1
    const [firstLine = '', ...rest] = blockLines
    const childPrefix = treeLine(lines, firstLine, last)
    childLines(lines, childPrefix, rest)
  })

  if (actionLines.length > 0) {
    const [firstLine = '', ...rest] = actionLines
    const childPrefix = treeLine(lines, firstLine, true)
    childLines(lines, childPrefix, rest)
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
