/**
 * hrc events renderer — tree / compact / verbose formatters.
 *
 * The verbose formatter is the historical `--pretty` output: a mechanical
 * walk of the payload JSON with a `cat:│g:│rt:│run:│launch:` tag line.
 *
 * The tree formatter is the new default. It groups consecutive events by
 * (scope, runtime+run, launch) and emits a horizontal rule whenever a band
 * changes, so IDs appear once per band instead of once per event. It also
 * folds tool_call + tool_result pairs (by toolUseId) and renders common
 * payload shapes (messages, shell commands, shell results) semantically
 * rather than as JSON.
 */
import { parseScopeRef } from 'agent-scope'
import chalk from 'chalk'
import type { HrcLifecycleEvent } from 'hrc-core'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type EventsOutputFormat = 'tree' | 'compact' | 'verbose' | 'json' | 'ndjson'

export interface TreeRendererOptions {
  /** Max lines per body block (command, result, prose). 0 = unlimited. Default 10. */
  maxLines?: number | undefined
  /** Width of the per-row scoperef badge, in chars. Default 20. */
  scopeWidth?: number | undefined
}

export function resolveDefaultFormat(isTty: boolean): EventsOutputFormat {
  return isTty ? 'tree' : 'ndjson'
}

export function createEventsRenderer(
  format: EventsOutputFormat,
  options: TreeRendererOptions = {}
): EventsRenderer {
  switch (format) {
    case 'tree':
      return new TreeRenderer(options)
    case 'compact':
      return new CompactRenderer()
    case 'verbose':
      return new VerboseRenderer()
    case 'json':
    case 'ndjson':
      return new JsonRenderer()
  }
}

export interface EventsRenderer {
  push(event: HrcLifecycleEvent): string
  flush(): string
}

// ---------------------------------------------------------------------------
// JSON / NDJSON renderer
// ---------------------------------------------------------------------------

class JsonRenderer implements EventsRenderer {
  push(event: HrcLifecycleEvent): string {
    return `${JSON.stringify(event)}\n`
  }
  flush(): string {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Tree renderer — the new default
// ---------------------------------------------------------------------------

interface BandState {
  scopeRef?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
}

interface PendingToolCall {
  ts: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  scopeRef: string
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
}

const DEFAULT_MAX_LINES = 10
const DEFAULT_SCOPE_WIDTH = 20

class TreeRenderer implements EventsRenderer {
  private band: BandState = {}
  private pendingToolCall: PendingToolCall | null = null
  private lastUserPrompt: { runId: string; content: string } | null = null
  private ruleWidth = Math.min(Math.max(process.stdout.columns ?? 88, 60), 120)
  private maxLines: number
  private scopeWidth: number

  constructor(options: TreeRendererOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES
    this.scopeWidth = Math.max(4, options.scopeWidth ?? DEFAULT_SCOPE_WIDTH)
  }

  push(event: HrcLifecycleEvent): string {
    const out: string[] = []

    // If we have a pending tool_call, try to fold with this event.
    if (this.pendingToolCall !== null) {
      if (isMatchingToolResult(event, this.pendingToolCall)) {
        out.push(...this.renderToolPair(this.pendingToolCall, event))
        this.pendingToolCall = null
        return this.join(out)
      }
      // Otherwise flush the pending tool_call on its own.
      out.push(...this.renderToolCallAlone(this.pendingToolCall))
      this.pendingToolCall = null
    }

    // Band transitions: emit a rule when scope / run / launch change.
    out.push(...this.emitBandTransitions(event))

    // Dispatch per event kind.
    if (event.eventKind === 'turn.tool_call') {
      this.pendingToolCall = toolCallFromEvent(event)
      return this.join(out)
    }

    out.push(...this.renderEvent(event))
    return this.join(out)
  }

  flush(): string {
    const out: string[] = []
    if (this.pendingToolCall !== null) {
      out.push(...this.renderToolCallAlone(this.pendingToolCall))
      this.pendingToolCall = null
    }
    return this.join(out)
  }

  // ---- Band headers -------------------------------------------------------

  private emitBandTransitions(event: HrcLifecycleEvent): string[] {
    const out: string[] = []
    // Band fields are sticky: an event with a missing field inherits the prior
    // band's value. Only a non-undefined value that differs from the sticky
    // state triggers a new rule.
    const scopeChanged =
      event.scopeRef !== this.band.scopeRef || event.generation !== this.band.generation
    const runtimeChanged = event.runtimeId !== undefined && event.runtimeId !== this.band.runtimeId
    const runIdChanged = event.runId !== undefined && event.runId !== this.band.runId
    const runChanged = scopeChanged || runtimeChanged || runIdChanged
    const launchChanged =
      runChanged || (event.launchId !== undefined && event.launchId !== this.band.launchId)

    if (scopeChanged) {
      out.push(this.scopeRule(event))
      this.band = { scopeRef: event.scopeRef, generation: event.generation }
      this.lastUserPrompt = null
    }
    if (runChanged && (event.runtimeId !== undefined || event.runId !== undefined)) {
      out.push(this.runRule(event))
      if (event.runtimeId !== undefined) this.band.runtimeId = event.runtimeId
      if (event.runId !== undefined) this.band.runId = event.runId
      // A new run resets the launch band — but only if runtime or runId actually changed.
      if (runtimeChanged || runIdChanged) this.band.launchId = undefined
    }
    if (launchChanged && event.launchId !== undefined) {
      out.push(this.launchRule(event))
      this.band.launchId = event.launchId
    }
    return out
  }

  private scopeRule(event: HrcLifecycleEvent): string {
    const handle = formatAgentHandle(event.scopeRef) ?? event.scopeRef
    const left = `── ${chalk.bgWhite.black.bold(` ${handle} `)} ${chalk.dim(`g:${event.generation}`)} `
    return this.hrule(left)
  }

  private runRule(event: HrcLifecycleEvent): string {
    const parts: string[] = []
    if (event.runtimeId) parts.push(chalk.cyan(shortId(event.runtimeId, 'rt')))
    if (event.runId) parts.push(chalk.cyanBright(shortId(event.runId, 'run')))
    if (event.transport) parts.push(chalk.dim(event.transport))
    const left = `── ${chalk.cyan('▸')} ${parts.join(chalk.dim(' · '))} `
    return this.hrule(left)
  }

  private launchRule(event: HrcLifecycleEvent): string {
    const left = `── ${chalk.magenta('↳')} ${chalk.magenta(shortId(event.launchId ?? '', 'launch'))} `
    return this.hrule(left)
  }

  private hrule(left: string): string {
    const visible = stripAnsi(left).length
    const pad = Math.max(3, this.ruleWidth - visible)
    return `${left}${chalk.dim('─'.repeat(pad))}\n`
  }

  // ---- Event dispatch -----------------------------------------------------

  private renderEvent(event: HrcLifecycleEvent): string[] {
    const kind = event.eventKind
    if (kind === 'turn.user_prompt') return this.renderUserPrompt(event)
    if (kind === 'turn.message') return this.renderMessage(event)
    if (kind === 'turn.tool_result') return this.renderOrphanToolResult(event)
    if (kind === 'turn.started') return this.renderSimple(event, '▶', 'turn started')
    if (kind === 'turn.accepted') return this.renderSimple(event, '▶', 'turn accepted')
    if (kind === 'turn.completed') return this.renderTurnCompleted(event)
    if (kind.startsWith('launch.')) return this.renderLaunchEvent(event)
    if (kind.startsWith('session.')) return this.renderSessionEvent(event)
    return this.renderGeneric(event)
  }

  private renderSimple(event: HrcLifecycleEvent, glyph: string, label: string): string[] {
    const payload = event.payload as Record<string, unknown> | null | undefined
    const inline = inlineAttrs(payload, ['transport', 'prompt', 'promptLength'])
    const head = this.prefix(event.ts, event.scopeRef, chalk.blue(glyph), chalk.blueBright(label))
    return [`${head}${inline ? `  ${inline}` : ''}\n`]
  }

  private renderUserPrompt(event: HrcLifecycleEvent): string[] {
    const content = extractMessageContent(event.payload)
    const runId = event.runId ?? ''

    if (
      this.lastUserPrompt !== null &&
      this.lastUserPrompt.runId === runId &&
      this.lastUserPrompt.content === content
    ) {
      const head = this.prefix(
        event.ts,
        event.scopeRef,
        chalk.dim('↻'),
        chalk.dim('user (forwarded to launch)')
      )
      return [`${head}\n`]
    }

    this.lastUserPrompt = { runId, content }
    const head = this.prefix(
      event.ts,
      event.scopeRef,
      chalk.greenBright('▸'),
      chalk.greenBright.bold('user')
    )
    const body = this.truncate(wrapRoleBody(content, this.bodyIndent(), 'user'))
    return [`${head}\n`, ...body.map((l) => `${l}\n`)]
  }

  private renderMessage(event: HrcLifecycleEvent): string[] {
    const role = extractMessageRole(event.payload)
    const content = extractMessageContent(event.payload)
    const isUser = role === 'user'
    const glyph = isUser ? chalk.greenBright('▸') : chalk.yellowBright('◇')
    const label = isUser ? chalk.greenBright.bold('user') : chalk.yellowBright.bold('assistant')
    const head = this.prefix(event.ts, event.scopeRef, glyph, label)
    const body = this.truncate(
      wrapRoleBody(content, this.bodyIndent(), isUser ? 'user' : 'assistant')
    )
    return [`${head}\n`, ...body.map((l) => `${l}\n`)]
  }

  private renderTurnCompleted(event: HrcLifecycleEvent): string[] {
    const payload = event.payload as { success?: boolean; result?: unknown } | null | undefined
    const success = payload?.success
    const glyph = success === false ? chalk.red('✗') : chalk.green('✓')
    const label = success === false ? chalk.red('turn failed') : chalk.green('turn completed')
    const head = this.prefix(event.ts, event.scopeRef, glyph, label)
    const body = extractNestedText(payload?.result)
    const lines = [`${head}\n`]
    for (const line of this.truncate(wrapBody(body, this.bodyIndent()))) lines.push(`${line}\n`)
    return lines
  }

  private renderSessionEvent(event: HrcLifecycleEvent): string[] {
    const kind = event.eventKind.slice('session.'.length)
    const payload = event.payload as Record<string, unknown> | null | undefined
    const inline = inlineAttrs(payload, Object.keys(payload ?? {}))
    const head = this.prefix(
      event.ts,
      event.scopeRef,
      chalk.greenBright('●'),
      chalk.greenBright(`session ${kind}`)
    )
    return [`${head}${inline ? `  ${inline}` : ''}\n`]
  }

  private renderLaunchEvent(event: HrcLifecycleEvent): string[] {
    const kind = event.eventKind.slice('launch.'.length)
    const payload = (event.payload ?? {}) as {
      wrapperPid?: unknown
      childPid?: unknown
      continuation?: { provider?: string; key?: string }
      exitCode?: unknown
    }

    if (kind === 'wrapper_started') {
      const head = this.prefix(
        event.ts,
        event.scopeRef,
        chalk.magenta('⎆'),
        chalk.magenta('wrapper')
      )
      return [`${head}  ${chalk.dim('pid')} ${chalk.white(String(payload.wrapperPid ?? '?'))}\n`]
    }
    if (kind === 'child_started') {
      const head = this.prefix(event.ts, event.scopeRef, chalk.magenta('⎆'), chalk.magenta('child'))
      return [`${head}  ${chalk.dim('pid')} ${chalk.white(String(payload.childPid ?? '?'))}\n`]
    }
    if (kind === 'continuation_captured') {
      const cont = payload.continuation ?? {}
      const provider = cont.provider ?? '?'
      const key = cont.key ? shortenKey(cont.key) : '?'
      const head = this.prefix(
        event.ts,
        event.scopeRef,
        chalk.magenta('⎆'),
        chalk.magenta('continuation')
      )
      return [`${head}  ${chalk.white(`${provider}/${key}`)}\n`]
    }
    if (kind === 'exited') {
      const exit = payload.exitCode
      const ok = exit === 0
      const glyph = ok ? chalk.green('✓') : chalk.red('✗')
      const label = ok ? chalk.green('launch exit') : chalk.red('launch exit')
      const head = this.prefix(event.ts, event.scopeRef, glyph, label)
      return [`${head}  ${chalk.white(String(exit ?? '?'))}\n`]
    }
    return this.renderGeneric(event)
  }

  private renderOrphanToolResult(event: HrcLifecycleEvent): string[] {
    const { result, isError } = parseToolResult(event.payload)
    const glyph = isError ? chalk.red('↳') : chalk.dim('↳')
    const head = this.prefix(event.ts, event.scopeRef, glyph, chalk.dim('tool result (orphan)'))
    const lines = [`${head}\n`]
    for (const line of this.truncate(wrapBody(result, this.bodyIndent()))) lines.push(`${line}\n`)
    return lines
  }

  private renderGeneric(event: HrcLifecycleEvent): string[] {
    const kindSuffix = event.eventKind.includes('.')
      ? event.eventKind.split('.').slice(1).join('.')
      : event.eventKind
    const head = this.prefix(
      event.ts,
      event.scopeRef,
      chalk.gray('·'),
      chalk.gray(`${event.category} ${kindSuffix}`)
    )
    const payload = stripInternalKeys(event.payload)
    const inline = inlineAttrs(
      payload as Record<string, unknown> | null | undefined,
      Object.keys((payload as Record<string, unknown> | null | undefined) ?? {})
    )
    if (inline) {
      return [`${head}  ${inline}\n`]
    }
    const body = renderPayloadBlock(payload, this.bodyIndent())
    return [`${head}\n`, ...this.truncate(body).map((l) => `${l}\n`)]
  }

  // ---- Tool call / result -------------------------------------------------

  private renderToolPair(call: PendingToolCall, result: HrcLifecycleEvent): string[] {
    const lines: string[] = []
    lines.push(...this.renderToolCallHeader(call))
    lines.push(...this.renderToolResultTail(result))
    return lines
  }

  private renderToolCallAlone(call: PendingToolCall): string[] {
    const lines: string[] = []
    lines.push(...this.renderToolCallHeader(call))
    const tail = this.continuationPrefix(chalk.dim('↳'), chalk.dim('(no result yet)'))
    lines.push(`${tail}\n`)
    return lines
  }

  private renderToolCallHeader(call: PendingToolCall): string[] {
    const toolLabel = chalk.magentaBright(call.toolName.toLowerCase())
    const idHint = chalk.dim(shortenKey(call.toolUseId))
    const head = this.prefix(
      call.ts,
      call.scopeRef,
      chalk.magentaBright('⟩'),
      `${toolLabel}  ${idHint}`
    )
    const lines = [`${head}\n`]
    const indent = this.bodyIndent()
    const cmdLines = formatShellCommand(call.input, call.toolName, this.ruleWidth - indent.length)
    if (cmdLines.length > 0) {
      const rendered = cmdLines.map((l) => `${indent}${l}`)
      for (const line of this.truncate(rendered)) lines.push(`${line}\n`)
    } else {
      const input = stripInternalKeys(call.input)
      const inline = inlineAttrs(
        input as Record<string, unknown> | null | undefined,
        Object.keys((input as Record<string, unknown> | null | undefined) ?? {})
      )
      if (inline) {
        lines.push(`${indent}${inline}\n`)
      } else {
        const body = renderPayloadBlock(input, indent)
        for (const line of this.truncate(body)) lines.push(`${line}\n`)
      }
    }
    return lines
  }

  private renderToolResultTail(event: HrcLifecycleEvent): string[] {
    const { result, isError, exitCode, duration } = parseToolResult(event.payload)
    const fail = isError || (exitCode !== undefined && exitCode !== 0)
    const glyph = fail ? chalk.red('↳') : chalk.green('↳')
    const statusParts: string[] = []
    if (exitCode !== undefined) statusParts.push(`exit ${exitCode}`)
    if (duration !== undefined) statusParts.push(`${duration.toFixed(2)}s`)
    const status = statusParts.length > 0 ? statusParts.join(chalk.dim(' · ')) : 'result'
    const colorer = fail ? chalk.red : chalk.green
    // Continuation: no timestamp, no badge — visually pairs with the ⟩ header.
    const head = this.continuationPrefix(glyph, colorer(status))
    const lines = [`${head}\n`]
    const indent = this.bodyIndent()
    const bodyLines = this.truncate(wrapBody(result, indent))
    for (const line of bodyLines) lines.push(`${line}\n`)
    return lines
  }

  // ---- Formatting helpers -------------------------------------------------

  private prefix(ts: string, scopeRef: string, glyph: string, label: string): string {
    return `  ${chalk.dim(formatShortTime(ts))}  ${this.formatBadge(scopeRef)}  ${glyph} ${label}`
  }

  /**
   * Continuation prefix: no timestamp, no badge. Used for the `↳` tail of a
   * folded tool_call + tool_result pair so the pair reads as one block.
   */
  private continuationPrefix(glyph: string, label: string): string {
    return `${this.bodyIndent()}${glyph} ${label}`
  }

  private formatBadge(scopeRef: string): string {
    const handle = formatCompactBadgeHandle(scopeRef)
    const w = this.scopeWidth
    const display = handle.length > w ? `${handle.slice(0, w - 1)}…` : handle.padEnd(w)
    return chalk.cyan(display)
  }

  private bodyIndent(): string {
    // 2 (leading) + 8 (time) + 2 (sep) + scopeWidth + 2 (sep) = 14 + scopeWidth
    return ' '.repeat(14 + this.scopeWidth)
  }

  /**
   * Apply --max-lines truncation to a list of already-formatted (indented) body
   * lines. Appends a dim "… (+N more lines)" hint when lines are dropped.
   */
  private truncate(lines: string[]): string[] {
    if (this.maxLines <= 0 || lines.length <= this.maxLines) return lines
    const shown = lines.slice(0, this.maxLines)
    const remaining = lines.length - this.maxLines
    const plural = remaining === 1 ? '' : 's'
    shown.push(
      `${this.bodyIndent()}${chalk.dim(`… (+${remaining} more line${plural}, --max-lines 0 to expand)`)}`
    )
    return shown
  }

  private join(parts: string[]): string {
    return parts.join('')
  }
}

// ---------------------------------------------------------------------------
// Compact renderer — one line per event, grep-friendly
// ---------------------------------------------------------------------------

class CompactRenderer implements EventsRenderer {
  push(event: HrcLifecycleEvent): string {
    const ts = formatShortTime(event.ts)
    const handle = formatAgentHandle(event.scopeRef) ?? event.scopeRef
    const kind = event.eventKind
    const ids: string[] = []
    if (event.runId) ids.push(shortId(event.runId, 'run'))
    if (event.launchId) ids.push(shortId(event.launchId, 'launch'))
    const summary = compactPayloadSummary(event)
    const parts = [
      chalk.dim(ts),
      chalk.whiteBright(handle),
      chalk.cyan(kind),
      ids.length > 0 ? chalk.dim(ids.join(' ')) : undefined,
      summary,
    ].filter((p): p is string => p !== undefined && p !== '')
    return `${parts.join('  ')}\n`
  }
  flush(): string {
    return ''
  }
}

function compactPayloadSummary(event: HrcLifecycleEvent): string {
  const kind = event.eventKind
  const p = event.payload as Record<string, unknown> | null | undefined
  if (!p) return ''
  if (kind === 'turn.user_prompt' || kind === 'turn.message') {
    const content = extractMessageContent(event.payload)
    const first = content.split('\n')[0] ?? ''
    const cropped = first.length > 80 ? `${first.slice(0, 77)}…` : first
    return chalk.white(cropped)
  }
  if (kind === 'turn.tool_call') {
    const maybe = p as { toolName?: unknown; name?: unknown }
    const name = maybe.toolName ?? maybe.name ?? '?'
    return chalk.magenta(`tool:${String(name)}`)
  }
  if (kind === 'turn.tool_result') {
    const { isError, exitCode } = parseToolResult(event.payload)
    return isError || (exitCode !== undefined && exitCode !== 0)
      ? chalk.red(`exit=${exitCode ?? 'err'}`)
      : chalk.green(`exit=${exitCode ?? 0}`)
  }
  return inlineAttrs(p, Object.keys(p)) ?? ''
}

// ---------------------------------------------------------------------------
// Verbose renderer — the legacy --pretty (preserved for debugging)
// ---------------------------------------------------------------------------

class VerboseRenderer implements EventsRenderer {
  push(event: HrcLifecycleEvent): string {
    return formatVerboseEvent(event)
  }
  flush(): string {
    return ''
  }
}

export function formatVerboseEvent(event: HrcLifecycleEvent): string {
  const theme = getWatchTheme(event.eventKind)
  const agent = formatAgentHandle(event.scopeRef)
  const kindSuffix = event.eventKind.includes('.')
    ? event.eventKind.split('.').slice(1).join('.')
    : event.eventKind
  const header = [
    agent
      ? `${chalk.bgWhite.black.bold(` ${agent} `)} ${theme.badge(` ${theme.label} `)} ${theme.accent.bold(kindSuffix)}`
      : `${theme.badge(` ${theme.label} `)} ${theme.accent.bold(kindSuffix)} ${theme.dim(event.scopeRef)}`,
    chalk.dim(`#${event.hrcSeq} @${event.streamSeq} ${formatLongTime(event.ts)}`),
  ].join(' ')

  const meta = [
    `${chalk.dim('cat:')}${theme.dim(event.category)}`,
    `${chalk.dim('g:')}${chalk.white(String(event.generation))}`,
    event.runtimeId ? `${chalk.dim('rt:')}${theme.dim(event.runtimeId)}` : undefined,
    event.runId ? `${chalk.dim('run:')}${theme.dim(event.runId)}` : undefined,
    event.launchId ? `${chalk.dim('launch:')}${theme.dim(event.launchId)}` : undefined,
    event.transport ? `${chalk.dim('transport:')}${theme.dim(event.transport)}` : undefined,
    event.errorCode ? `${chalk.dim('error:')}${chalk.red(event.errorCode)}` : undefined,
    event.appSessionKey ? `${chalk.dim('app:')}${theme.dim(event.appSessionKey)}` : undefined,
    event.replayed ? chalk.dim('replayed') : undefined,
  ].filter((part): part is string => part !== undefined)

  const prettyValue = sanitizePrettyValue(event.payload, undefined, event.eventKind)
  const inlineDetails = renderInlinePrettyValue(prettyValue, theme)
  const details = inlineDetails ? [] : renderPrettyValue(prettyValue, '', theme)
  const summary = inlineDetails ? [...meta, inlineDetails] : meta
  const metaLine = summary.join(chalk.dim(' │ '))
  const lines = [header, `  ${metaLine}`]
  if (details.length > 0) {
    lines.push(...details.map((line) => `  ${line}`))
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

const INTERNAL_KEYS = new Set(['hostSessionId', 'launchId', 'replayed', 'type'])

function stripInternalKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInternalKeys)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([k]) => !INTERNAL_KEYS.has(k)
  )
  return Object.fromEntries(entries.map(([k, v]) => [k, stripInternalKeys(v)]))
}

function extractMessageContent(payload: unknown): string {
  const p = payload as { message?: { content?: unknown }; content?: unknown } | null | undefined
  const content = p?.message?.content ?? p?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object') {
          const b = block as { type?: string; text?: string }
          if (b.type === 'text' && typeof b.text === 'string') return b.text
        }
        return ''
      })
      .filter((s) => s.length > 0)
      .join('\n')
  }
  return ''
}

function extractMessageRole(payload: unknown): 'user' | 'assistant' | string {
  const p = payload as { message?: { role?: string } } | null | undefined
  return p?.message?.role ?? 'assistant'
}

function extractNestedText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const v = value as { content?: unknown }
  if (Array.isArray(v.content)) {
    return v.content
      .map((block) => {
        const b = block as { type?: string; text?: string }
        return b?.type === 'text' && typeof b.text === 'string' ? b.text : ''
      })
      .filter((s) => s.length > 0)
      .join('\n')
  }
  return ''
}

function toolCallFromEvent(event: HrcLifecycleEvent): PendingToolCall {
  const p = event.payload as
    | {
        toolUseId?: string
        toolName?: string
        input?: Record<string, unknown>
      }
    | null
    | undefined
  return {
    ts: event.ts,
    toolUseId: p?.toolUseId ?? '',
    toolName: p?.toolName ?? 'tool',
    input: p?.input ?? {},
    scopeRef: event.scopeRef,
    runtimeId: event.runtimeId,
    runId: event.runId,
    launchId: event.launchId,
  }
}

function isMatchingToolResult(event: HrcLifecycleEvent, call: PendingToolCall): boolean {
  if (event.eventKind !== 'turn.tool_result') return false
  if (event.scopeRef !== call.scopeRef) return false
  if (event.runId !== call.runId) return false
  if (event.launchId !== call.launchId) return false
  const p = event.payload as { toolUseId?: string } | null | undefined
  return p?.toolUseId === call.toolUseId
}

interface ParsedToolResult {
  result: string
  isError: boolean
  exitCode?: number | undefined
  duration?: number | undefined
}

function parseToolResult(payload: unknown): ParsedToolResult {
  const p = payload as
    | {
        result?: { content?: Array<{ type?: string; text?: string }> }
        isError?: boolean
      }
    | null
    | undefined
  const isError = p?.isError === true
  const content = p?.result?.content ?? []
  const joined = content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((s) => s.length > 0)
    .join('\n')

  // Claude shell tool wraps output as `{"output":"...","metadata":{"exit_code":N,"duration_seconds":S}}`
  const jsonEnvelope = parseShellEnvelope(joined)
  if (jsonEnvelope !== null) {
    return {
      result: jsonEnvelope.output,
      isError,
      exitCode: jsonEnvelope.exitCode,
      duration: jsonEnvelope.duration,
    }
  }

  // Codex exec_command wraps output with a plain-text preamble:
  //   Chunk ID: <id>
  //   Wall time: <N> seconds
  //   Process exited with code <N>
  //   Original token count: <N>
  //   Output:
  //   <the actual output>
  const codexEnvelope = parseCodexEnvelope(joined)
  if (codexEnvelope !== null) {
    return {
      result: codexEnvelope.output,
      isError,
      exitCode: codexEnvelope.exitCode,
      duration: codexEnvelope.duration,
    }
  }

  return { result: joined, isError }
}

function parseCodexEnvelope(text: string): ShellEnvelope | null {
  if (!text.includes('Process exited with code')) return null
  const lines = text.split('\n')
  let exitCode: number | undefined
  let duration: number | undefined
  let outputStart = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const exitMatch = line.match(/^Process exited with code (-?\d+)/)
    if (exitMatch?.[1] !== undefined) exitCode = Number(exitMatch[1])
    const timeMatch = line.match(/^Wall time:\s*([\d.]+)\s*seconds/)
    if (timeMatch?.[1] !== undefined) duration = Number(timeMatch[1])
    if (line === 'Output:') {
      outputStart = i + 1
      break
    }
  }
  if (outputStart < 0) return null
  const output = lines.slice(outputStart).join('\n')
  return { output, exitCode, duration }
}

interface ShellEnvelope {
  output: string
  exitCode?: number | undefined
  duration?: number | undefined
}

function parseShellEnvelope(text: string): ShellEnvelope | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const parsed = JSON.parse(trimmed) as {
      output?: unknown
      metadata?: { exit_code?: unknown; duration_seconds?: unknown }
    }
    if (typeof parsed.output !== 'string') return null
    const meta = parsed.metadata ?? {}
    const exitCode = typeof meta.exit_code === 'number' ? meta.exit_code : undefined
    const duration = typeof meta.duration_seconds === 'number' ? meta.duration_seconds : undefined
    return { output: parsed.output, exitCode, duration }
  } catch {
    return null
  }
}

function formatShellCommand(
  input: Record<string, unknown>,
  toolName: string,
  maxWidth: number
): string[] {
  const lowerName = toolName.toLowerCase()
  const isShell =
    lowerName === 'bash' ||
    lowerName === 'shell' ||
    lowerName === 'sh' ||
    lowerName === 'exec_command'
  if (!isShell) return []

  // Codex's exec_command uses `cmd` (string); Claude's Bash uses `command` (array or string).
  const command = (input as { command?: unknown }).command ?? (input as { cmd?: unknown }).cmd
  let script: string | undefined
  if (Array.isArray(command)) {
    // Look for `-lc`/`-c` pattern: ['bash', '-lc', '...'] or ['-c', '...']
    const flagIdx = command.findIndex((c) => c === '-lc' || c === '-c' || c === '--command')
    if (flagIdx >= 0 && typeof command[flagIdx + 1] === 'string') {
      script = command[flagIdx + 1] as string
    } else {
      const stringParts = command.filter((c): c is string => typeof c === 'string')
      script = stringParts.join(' ')
    }
  } else if (typeof command === 'string') {
    script = command
  }

  if (!script) return []
  const prefix = chalk.dim('$ ')
  const wrapped = wrapShellScript(script, Math.max(20, maxWidth - 4))
  const first = wrapped[0] ?? ''
  return [`${prefix}${chalk.white(first)}`, ...wrapped.slice(1).map((l) => `  ${chalk.white(l)}`)]
}

function wrapShellScript(script: string, width: number): string[] {
  const lines = script.split('\n')
  if (lines.length === 1 && lines[0]!.length <= width) return [lines[0]!]
  // For multi-line scripts, preserve line structure; for single long line, break at spaces.
  if (lines.length > 1) return lines
  const parts: string[] = []
  let current = ''
  for (const token of lines[0]!.split(/(\s+)/)) {
    if ((current + token).length > width && current.length > 0) {
      parts.push(`${current.trimEnd()} \\`)
      current = token.trimStart()
    } else {
      current += token
    }
  }
  if (current.length > 0) parts.push(current)
  return parts
}

function inlineAttrs(
  payload: Record<string, unknown> | null | undefined,
  preferredOrder: string[]
): string | undefined {
  if (!payload) return undefined
  const pairs: string[] = []
  const seen = new Set<string>()
  for (const key of preferredOrder) {
    if (!(key in payload)) continue
    seen.add(key)
    const v = payload[key]
    if (!isInlinePrimitive(v)) return undefined
    pairs.push(`${chalk.dim(key)}=${formatInlineValue(v)}`)
  }
  for (const [key, value] of Object.entries(payload)) {
    if (seen.has(key)) continue
    if (!isInlinePrimitive(value)) return undefined
    pairs.push(`${chalk.dim(key)}=${formatInlineValue(value)}`)
  }
  if (pairs.length === 0) return undefined
  return pairs.join(chalk.dim(' · '))
}

function isInlinePrimitive(value: unknown): value is string | number | boolean | null {
  if (value === null) return true
  if (typeof value === 'boolean' || typeof value === 'number') return true
  if (typeof value === 'string') return !value.includes('\n') && value.length < 80
  return false
}

function formatInlineValue(value: string | number | boolean | null): string {
  if (value === null) return chalk.dim('null')
  if (typeof value === 'boolean') return value ? chalk.green('true') : chalk.red('false')
  if (typeof value === 'number') return chalk.white(String(value))
  return chalk.white(value)
}

function renderPayloadBlock(value: unknown, indent: string): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') {
    return value.split('\n').map((l) => `${indent}${chalk.white(l)}`)
  }
  if (typeof value !== 'object') {
    return [`${indent}${chalk.white(String(value))}`]
  }
  return renderPrettyValue(value, indent, getWatchTheme('generic'))
}

function wrapBody(text: string, indent: string): string[] {
  if (text.length === 0) return []
  // Strip leading/trailing blank lines; a lone trailing \n is common in shell output.
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  return lines.map((line) => `${indent}${chalk.white(line)}`)
}

/**
 * Role-aware body wrap: renders user/assistant utterances as a quoted transcript
 * block so the two roles read distinctly at a glance. User lines get a thick
 * green gutter bar and bright-white prose (imperative input); assistant lines
 * get a thin dim-amber gutter bar and amber prose (reflective output).
 */
function wrapRoleBody(text: string, indent: string, role: 'user' | 'assistant'): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  if (role === 'user') {
    const bar = chalk.greenBright('▎')
    return lines.map((line) => `${indent}${bar} ${chalk.whiteBright(line)}`)
  }
  const bar = chalk.yellow('│')
  return lines.map((line) => `${indent}${bar} ${chalk.yellow(line)}`)
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

export function formatAgentHandle(scopeRef: string): string | undefined {
  try {
    const parsed = parseScopeRef(scopeRef)
    if (parsed.projectId === undefined) return parsed.agentId
    return parsed.taskId
      ? `${parsed.agentId}@${parsed.projectId}:${parsed.taskId}`
      : `${parsed.agentId}@${parsed.projectId}`
  } catch {
    return undefined
  }
}

/**
 * Compact form of the agent handle for per-row badges. Drops the project
 * segment when a task is present, since the scope band above already shows
 * the full path — the row badge just needs to distinguish agents/threads.
 *   agent + task    → "agent:task"     (most specific, task is usually the session id)
 *   agent + project → "agent@project"  (no task — keep project to disambiguate)
 *   agent only      → "agent"
 */
function formatCompactBadgeHandle(scopeRef: string): string {
  try {
    const parsed = parseScopeRef(scopeRef)
    if (parsed.taskId !== undefined) return `${parsed.agentId}:${parsed.taskId}`
    if (parsed.projectId !== undefined) return `${parsed.agentId}@${parsed.projectId}`
    return parsed.agentId
  } catch {
    return scopeRef
  }
}

function formatFriendlyScopeLane(scopeRef: string, laneRef: string): string {
  try {
    const parsed = parseScopeRef(scopeRef)
    const friendly =
      parsed.projectId === undefined
        ? parsed.agentId
        : parsed.taskId
          ? `${parsed.agentId}@${parsed.projectId}:${parsed.taskId}`
          : `${parsed.agentId}@${parsed.projectId}`
    return `${friendly}:${laneRef}`
  } catch {
    return `${scopeRef}/lane:${laneRef}`
  }
}

function formatFriendlySessionRef(sessionRef: string): string {
  const match = sessionRef.match(/^(.+)\/lane:([^/]+)$/)
  if (!match?.[1] || !match[2]) return sessionRef
  return formatFriendlyScopeLane(match[1], match[2])
}

function shortId(id: string, prefix: string): string {
  if (!id) return `${prefix}-?`
  // id format: `<prefix>-<uuid>` — keep prefix, shorten uuid to first 8 chars
  const dashIdx = id.indexOf('-')
  if (dashIdx === -1) return id
  const head = id.slice(0, dashIdx)
  const tail = id.slice(dashIdx + 1)
  if (tail.length <= 8) return id
  return `${head}-${tail.slice(0, 8)}`
}

function shortenKey(key: string): string {
  if (key.length <= 16) return key
  return `${key.slice(0, 8)}…${key.slice(-6)}`
}

function formatShortTime(ts: string): string {
  // ts is ISO; take HH:MM:SS
  const m = ts.match(/T(\d{2}:\d{2}:\d{2})/)
  return m?.[1] ?? ts
}

function formatLongTime(ts: string): string {
  return ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g')

function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '')
}

// ---------------------------------------------------------------------------
// Verbose renderer internals (preserved from cli.ts)
// ---------------------------------------------------------------------------

const STRIPPED_KEYS = new Set(['hostSessionId', 'launchId', 'replayed'])

function sanitizePrettyValue(value: unknown, key?: string, eventKind?: string): unknown {
  if (key !== undefined && STRIPPED_KEYS.has(key)) return undefined
  if (key === 'type' && eventKind !== undefined && value === eventKind) return undefined
  if (typeof value === 'string' && key === 'sessionRef') {
    return formatFriendlySessionRef(value)
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => sanitizePrettyValue(item, undefined, eventKind))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(
        ([childKey, childValue]) =>
          [childKey, sanitizePrettyValue(childValue, childKey, eventKind)] as const
      )
      .filter(([, childValue]) => childValue !== undefined)
  )
}

function renderPrettyValue(
  value: unknown,
  indent = '',
  theme: WatchTheme = getWatchTheme('generic')
): string[] {
  if (value === undefined) return []
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${chalk.dim('(empty)')}`]
    return value.flatMap((item, index) => {
      const marker = `${theme.gutter(`${indent}|`)} ${chalk.dim(`[${index + 1}]`)}`
      if (!isPrettyPrimitive(item)) {
        return [marker, ...renderPrettyValue(item, `${indent}  `, theme)]
      }
      const lines = formatPrettyPrimitiveLines(item)
      return [
        `${marker} ${lines[0]}`,
        ...lines
          .slice(1)
          .map(
            (line) => `${theme.gutter(`${indent}|`)} ${' '.repeat(`[${index + 1}]`.length)} ${line}`
          ),
      ]
    })
  }
  if (isPrettyPrimitive(value)) {
    return formatPrettyPrimitiveLines(value).map((line) => `${indent}${line}`)
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return [`${indent}${chalk.dim('(empty)')}`]
  const keyWidth = Math.min(16, Math.max(...entries.map(([key]) => key.length)))
  return entries.flatMap(([key, childValue]) => {
    if (!isPrettyPrimitive(childValue)) {
      return [
        `${theme.gutter(`${indent}|`)} ${theme.key(key.toUpperCase())}`,
        ...renderPrettyValue(childValue, `${indent}  `, theme),
      ]
    }
    const lines = formatPrettyPrimitiveLines(childValue)
    return [
      `${theme.gutter(`${indent}|`)} ${theme.key(key.padEnd(keyWidth))} ${chalk.dim(':')} ${lines[0]}`,
      ...lines
        .slice(1)
        .map((line) => `${theme.gutter(`${indent}|`)} ${' '.repeat(keyWidth)}   ${line}`),
    ]
  })
}

function renderInlinePrettyValue(value: unknown, theme: WatchTheme): string | undefined {
  if (value === undefined) return undefined
  if (isPrettyPrimitive(value)) {
    if (typeof value === 'string' && value.includes('\n')) return undefined
    return `${chalk.dim('VALUE')} ${formatPrettyPrimitive(value)}`
  }
  if (Array.isArray(value) || !value || typeof value !== 'object') return undefined
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > 3) return undefined
  if (entries.some(([, childValue]) => !isPrettyPrimitive(childValue))) return undefined
  if (
    entries.some(([, childValue]) => typeof childValue === 'string' && childValue.includes('\n'))
  ) {
    return undefined
  }
  return entries
    .map(([key, childValue]) => `${theme.key(key)} ${formatPrettyPrimitive(childValue)}`)
    .join(chalk.dim('  /  '))
}

function isPrettyPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function formatPrettyPrimitive(value: string | number | boolean | null): string {
  if (value === null) return chalk.dim('null')
  if (typeof value === 'boolean') return value ? chalk.green('true') : chalk.red('false')
  if (typeof value === 'number') return chalk.white(String(value))
  return chalk.white(value)
}

function formatPrettyPrimitiveLines(value: string | number | boolean | null): string[] {
  if (typeof value !== 'string' || !value.includes('\n')) {
    return [formatPrettyPrimitive(value)]
  }
  return value.split('\n').map((line) => chalk.white(line))
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

type WatchTheme = {
  label: string
  badge: (text: string) => string
  accent: typeof chalk
  dim: (text: string) => string
  gutter: (text: string) => string
  key: (text: string) => string
}

function getWatchTheme(eventKind: string): WatchTheme {
  if (eventKind.startsWith('turn.')) {
    return {
      label: '▶ TURN',
      badge: chalk.bgBlueBright.white.bold,
      accent: chalk.blueBright,
      dim: chalk.blue,
      gutter: chalk.blueBright.dim,
      key: chalk.whiteBright,
    }
  }
  if (eventKind.startsWith('session.')) {
    return {
      label: 'SESSION',
      badge: chalk.bgGreen.black,
      accent: chalk.greenBright,
      dim: chalk.green,
      gutter: chalk.green.dim,
      key: chalk.greenBright,
    }
  }
  if (eventKind.startsWith('runtime.')) {
    return {
      label: 'RUNTIME',
      badge: chalk.bgCyan.black,
      accent: chalk.cyanBright,
      dim: chalk.cyan.dim,
      gutter: chalk.cyan.dim,
      key: chalk.cyanBright,
    }
  }
  if (eventKind.startsWith('launch.')) {
    return {
      label: 'launch',
      badge: chalk.magenta.dim,
      accent: chalk.magenta.dim,
      dim: chalk.magenta.dim,
      gutter: chalk.magenta.dim,
      key: chalk.magenta,
    }
  }
  if (eventKind.startsWith('bridge.')) {
    return {
      label: 'BRIDGE',
      badge: chalk.bgBlue.white,
      accent: chalk.blue,
      dim: chalk.blue.dim,
      gutter: chalk.blue.dim,
      key: chalk.blueBright,
    }
  }
  if (eventKind.startsWith('inflight.')) {
    return {
      label: 'inflight',
      badge: chalk.gray,
      accent: chalk.white.dim,
      dim: chalk.gray,
      gutter: chalk.gray,
      key: chalk.white,
    }
  }
  if (eventKind.startsWith('surface.')) {
    return {
      label: 'surface',
      badge: chalk.gray,
      accent: chalk.gray,
      dim: chalk.gray,
      gutter: chalk.gray,
      key: chalk.white,
    }
  }
  if (eventKind.startsWith('context.')) {
    return {
      label: 'context',
      badge: chalk.gray,
      accent: chalk.gray,
      dim: chalk.gray,
      gutter: chalk.gray,
      key: chalk.white,
    }
  }
  if (eventKind.startsWith('app-session.')) {
    return {
      label: 'app',
      badge: chalk.green.dim,
      accent: chalk.green.dim,
      dim: chalk.green.dim,
      gutter: chalk.green.dim,
      key: chalk.green,
    }
  }
  return {
    label: 'EVENT',
    badge: chalk.bgWhite.black,
    accent: chalk.white,
    dim: chalk.gray,
    gutter: chalk.gray,
    key: chalk.whiteBright,
  }
}
