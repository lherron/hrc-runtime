import { parseScopeRef } from 'agent-scope'
import chalk from 'chalk'
import type { HrcEventCategory, HrcLifecycleEvent } from 'hrc-core'

export type MonitorOutputFormat = 'tree' | 'compact' | 'verbose' | 'json' | 'ndjson'

export type MonitorRenderableEvent = Record<string, unknown>

export type MonitorRendererOptions = {
  maxLines?: number | undefined
  scopeWidth?: number | undefined
}

export type MonitorRenderer = {
  push(event: MonitorRenderableEvent): string
  flush(): string
}

type PendingToolCall = {
  event: HrcLifecycleEvent
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

type ParsedToolResult = {
  output: string
  stdout?: string | undefined
  stderr?: string | undefined
  exitCode?: number | undefined
  durationSeconds?: number | undefined
  interrupted?: boolean | undefined
  isError?: boolean | undefined
}

type BandState = {
  scopeRef?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
}

const DEFAULT_MAX_LINES = 10
const DEFAULT_SCOPE_WIDTH = 20

export function parseMonitorOutputFormat(raw: string): MonitorOutputFormat {
  switch (raw) {
    case 'tree':
    case 'compact':
    case 'verbose':
    case 'json':
    case 'ndjson':
      return raw
    default:
      throw new Error(
        `--format must be one of: tree, compact, verbose, json, ndjson (got "${raw}")`
      )
  }
}

export function resolveMonitorOutputFormat(options: {
  format?: MonitorOutputFormat | undefined
  pretty?: boolean | undefined
  json?: boolean | undefined
}): MonitorOutputFormat {
  if (options.format) return options.format
  if (options.pretty) return 'tree'
  if (options.json) return 'ndjson'
  return 'ndjson'
}

export function createMonitorRenderer(
  format: MonitorOutputFormat,
  options: MonitorRendererOptions = {}
): MonitorRenderer {
  switch (format) {
    case 'tree':
      return new TreeMonitorRenderer(options)
    case 'compact':
      return new CompactMonitorRenderer()
    case 'verbose':
      return new VerboseMonitorRenderer()
    case 'json':
    case 'ndjson':
      return new JsonMonitorRenderer()
  }
}

export function toMonitorJsonEvent(
  event: MonitorRenderableEvent,
  selector: string,
  replayed: boolean
): Record<string, unknown> {
  const eventName = stringField(event, 'event') ?? stringField(event, 'eventKind') ?? 'unknown'
  const output: Record<string, unknown> = {
    event: eventName,
    selector: stringField(event, 'selector') ?? selector,
    replayed,
    ts: stringField(event, 'ts') ?? new Date().toISOString(),
  }

  const seq = numberField(event, 'seq') ?? numberField(event, 'hrcSeq')
  if (seq !== undefined) output['seq'] = seq

  for (const key of [
    'runtimeId',
    'turnId',
    'result',
    'failureKind',
    'reason',
    'condition',
    'messageId',
  ]) {
    const value = stringField(event, key)
    if (value) output[key] = value
  }

  const messageSeq = numberField(event, 'messageSeq')
  if (messageSeq !== undefined) output['messageSeq'] = messageSeq
  const exitCode = numberField(event, 'exitCode')
  if (exitCode !== undefined) output['exitCode'] = exitCode

  return output
}

class JsonMonitorRenderer implements MonitorRenderer {
  push(event: MonitorRenderableEvent): string {
    return `${JSON.stringify(event)}\n`
  }

  flush(): string {
    return ''
  }
}

class CompactMonitorRenderer implements MonitorRenderer {
  push(event: MonitorRenderableEvent): string {
    const lifecycle = toLifecycleEvent(event)
    const ids = [
      lifecycle.runtimeId ? shortId(lifecycle.runtimeId, 'rt') : undefined,
      lifecycle.runId ? shortId(lifecycle.runId, 'run') : undefined,
      lifecycle.launchId ? shortId(lifecycle.launchId, 'launch') : undefined,
    ].filter((part): part is string => part !== undefined)
    const suffix = ids.length > 0 ? ` ${chalk.dim(ids.join(' '))}` : ''
    return `${chalk.dim(formatShortTime(lifecycle.ts))} ${chalk.cyan(formatCompactBadgeHandle(lifecycle.scopeRef))} ${lifecycle.eventKind}${suffix}\n`
  }

  flush(): string {
    return ''
  }
}

class VerboseMonitorRenderer implements MonitorRenderer {
  push(event: MonitorRenderableEvent): string {
    const lifecycle = toLifecycleEvent(event)
    const header = [
      chalk.bgWhite.black.bold(` ${formatAgentHandle(lifecycle.scopeRef) ?? lifecycle.scopeRef} `),
      chalk.magenta(` ${lifecycle.category} `),
      chalk.bold(lifecycle.eventKind),
      chalk.dim(`#${lifecycle.hrcSeq} @${lifecycle.streamSeq} ${formatLongTime(lifecycle.ts)}`),
    ].join(' ')
    const meta = [
      `g:${lifecycle.generation}`,
      lifecycle.runtimeId ? shortId(lifecycle.runtimeId, 'rt') : undefined,
      lifecycle.runId ? shortId(lifecycle.runId, 'run') : undefined,
      lifecycle.launchId ? shortId(lifecycle.launchId, 'launch') : undefined,
      lifecycle.replayed ? 'replayed' : undefined,
    ].filter((part): part is string => part !== undefined)
    const details = renderPrettyValue(lifecycle.payload, '')
    return [
      `${header}\n`,
      `  ${chalk.dim(meta.join(' | '))}\n`,
      ...details.map((line) => `${line}\n`),
    ].join('')
  }

  flush(): string {
    return ''
  }
}

class TreeMonitorRenderer implements MonitorRenderer {
  private band: BandState = {}
  private pendingToolCall: PendingToolCall | null = null
  private lastUserPrompt: { runId: string; content: string } | null = null
  private sawReplayed = false
  private emittedLiveBoundary = false
  private readonly ruleWidth = Math.min(Math.max(process.stdout.columns ?? 88, 60), 120)
  private readonly maxLines: number
  private readonly scopeWidth: number

  constructor(options: MonitorRendererOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES
    this.scopeWidth = Math.max(4, options.scopeWidth ?? DEFAULT_SCOPE_WIDTH)
  }

  push(event: MonitorRenderableEvent): string {
    const lifecycle = toLifecycleEvent(event)
    const out: string[] = []

    if (this.shouldEmitLiveBoundary(lifecycle)) {
      if (this.pendingToolCall) {
        out.push(...this.renderToolCallAlone(this.pendingToolCall))
        this.pendingToolCall = null
      }
      out.push(this.liveRule())
    }

    if (this.pendingToolCall) {
      if (isMatchingToolResult(lifecycle, this.pendingToolCall)) {
        out.push(...this.renderToolPair(this.pendingToolCall, lifecycle))
        this.pendingToolCall = null
        return out.join('')
      }
      out.push(...this.renderToolCallAlone(this.pendingToolCall))
      this.pendingToolCall = null
    }

    out.push(...this.emitBandTransitions(lifecycle))

    if (lifecycle.eventKind === 'turn.tool_call') {
      this.pendingToolCall = toolCallFromEvent(lifecycle)
      return out.join('')
    }

    out.push(...this.renderEvent(lifecycle))
    return out.join('')
  }

  flush(): string {
    if (!this.pendingToolCall) return ''
    const out = this.renderToolCallAlone(this.pendingToolCall).join('')
    this.pendingToolCall = null
    return out
  }

  private emitBandTransitions(event: HrcLifecycleEvent): string[] {
    const out: string[] = []
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
    return this.hrule(
      `-- ${chalk.bgWhite.black.bold(` ${handle} `)} ${chalk.dim(`g:${event.generation}`)} `
    )
  }

  private runRule(event: HrcLifecycleEvent): string {
    const parts = [
      event.runtimeId ? chalk.cyan(shortId(event.runtimeId, 'rt')) : undefined,
      event.runId ? chalk.cyanBright(shortId(event.runId, 'run')) : undefined,
      event.transport ? chalk.dim(event.transport) : undefined,
    ].filter((part): part is string => part !== undefined)
    return this.hrule(`-- ${chalk.cyan('>')} ${parts.join(chalk.dim(' * '))} `)
  }

  private launchRule(event: HrcLifecycleEvent): string {
    return this.hrule(
      `-- ${chalk.magenta('->')} ${chalk.magenta(shortId(event.launchId ?? '', 'launch'))} `
    )
  }

  private hrule(left: string): string {
    const pad = Math.max(3, this.ruleWidth - stripAnsi(left).length)
    return `${left}${chalk.dim('-'.repeat(pad))}\n`
  }

  private liveRule(): string {
    return this.hrule(`-- ${chalk.green('live events')} `)
  }

  private shouldEmitLiveBoundary(event: HrcLifecycleEvent): boolean {
    if (event.replayed) {
      this.sawReplayed = true
      return false
    }
    if (!this.sawReplayed || this.emittedLiveBoundary) return false
    this.emittedLiveBoundary = true
    return true
  }

  private renderEvent(event: HrcLifecycleEvent): string[] {
    if (event.eventKind === 'turn.user_prompt') return this.renderUserPrompt(event)
    if (event.eventKind === 'turn.message') return this.renderMessage(event)
    if (event.eventKind === 'turn.tool_result') return this.renderOrphanToolResult(event)
    if (event.eventKind === 'turn.completed' || event.eventKind === 'turn.finished') {
      return this.renderCompleted(event)
    }
    return this.renderGeneric(event)
  }

  private renderUserPrompt(event: HrcLifecycleEvent): string[] {
    const content = extractMessageContent(event.payload)
    const runId = event.runId ?? ''
    if (this.lastUserPrompt?.runId === runId && this.lastUserPrompt.content === content) {
      return [`${this.prefix(event, chalk.dim('~'), chalk.dim('user (forwarded to launch)'))}\n`]
    }
    this.lastUserPrompt = { runId, content }
    return this.bodyBlock(event, chalk.greenBright('>'), chalk.greenBright.bold('user'), content)
  }

  private renderMessage(event: HrcLifecycleEvent): string[] {
    const role = extractMessageRole(event.payload)
    const isUser = role === 'user'
    return this.bodyBlock(
      event,
      isUser ? chalk.greenBright('>') : chalk.yellowBright('*'),
      isUser ? chalk.greenBright.bold('user') : chalk.yellowBright.bold('assistant'),
      extractMessageContent(event.payload)
    )
  }

  private renderCompleted(event: HrcLifecycleEvent): string[] {
    const payload = asRecord(event.payload)
    const success = payload?.['success']
    const failed = success === false || stringField(payload ?? {}, 'result')?.includes('failed')
    const label = failed ? chalk.red('turn failed') : chalk.green('turn completed')
    return [
      `${this.prefix(event, failed ? chalk.red('x') : chalk.green('v'), label)}${inlinePayload(payload)}\n`,
    ]
  }

  private renderGeneric(event: HrcLifecycleEvent): string[] {
    const payload = asRecord(event.payload)
    const kindSuffix = event.eventKind.includes('.')
      ? event.eventKind.split('.').slice(1).join('.')
      : event.eventKind
    return [
      `${this.prefix(event, glyphFor(event), chalk.blueBright(kindSuffix))}${inlinePayload(payload)}\n`,
    ]
  }

  private renderOrphanToolResult(event: HrcLifecycleEvent): string[] {
    const payload = asRecord(event.payload)
    const toolName = stringField(payload ?? {}, 'toolName') ?? 'tool'
    const parsed = parseToolResult(event.payload)
    const out = [
      `${this.prefix(
        event,
        chalk.magenta('<'),
        chalk.magenta(`${formatToolDisplayName(toolName)} result`)
      )}\n`,
    ]
    out.push(...this.renderToolResultBody(parsed))
    return out
  }

  private renderToolPair(call: PendingToolCall, result: HrcLifecycleEvent): string[] {
    const out: string[] = []
    out.push(...this.renderToolCallHeader(call, false))
    const parsed = parseToolResult(result.payload)
    const label = formatToolResultLabel(parsed)
    const duration =
      parsed.durationSeconds === undefined ? '' : ` ${parsed.durationSeconds.toFixed(2)}s`
    out.push(
      `${this.bodyIndent()}${chalk.dim('->')} ${chalk.magenta(label)}${chalk.dim(duration)}\n`
    )
    out.push(...this.renderToolResultBody(parsed))
    return out
  }

  private renderToolCallAlone(call: PendingToolCall): string[] {
    return [
      ...this.renderToolCallHeader(call, true),
      `${this.bodyIndent()}${chalk.dim('(no result yet)')}\n`,
    ]
  }

  private renderToolCallHeader(call: PendingToolCall, includeNoResult: boolean): string[] {
    const title = formatToolTitle(call.toolName, call.input)
    const head = this.prefix(call.event, chalk.magenta('$'), chalk.magenta(title))
    const commandLines = formatToolCallBody(call.toolName, call.input)
    const out = [`${head}\n`]
    for (const line of this.truncate(wrapBody(commandLines.join('\n'), this.bodyIndent()))) {
      out.push(`${line}\n`)
    }
    if (includeNoResult && commandLines.length === 0) {
      out.push(`${this.bodyIndent()}${chalk.dim('(no input)')}\n`)
    }
    return out
  }

  private bodyBlock(
    event: HrcLifecycleEvent,
    glyph: string,
    label: string,
    body: string
  ): string[] {
    const out = [`${this.prefix(event, glyph, label)}\n`]
    for (const line of this.truncate(wrapBody(body, this.bodyIndent()))) out.push(`${line}\n`)
    return out
  }

  private renderToolResultBody(result: ParsedToolResult): string[] {
    const out: string[] = []
    if (result.interrupted) {
      out.push(`${this.bodyIndent()}${chalk.red('interrupted')}\n`)
    }
    if (result.stdout !== undefined || result.stderr !== undefined) {
      if (result.stdout) {
        out.push(`${this.bodyIndent()}${chalk.dim('stdout')}\n`)
        for (const line of this.truncate(
          formatToolOutput(result.stdout, `${this.bodyIndent()}  `)
        )) {
          out.push(`${line}\n`)
        }
      }
      if (result.stderr) {
        out.push(`${this.bodyIndent()}${chalk.dim('stderr')}\n`)
        for (const line of this.truncate(
          formatToolOutput(result.stderr, `${this.bodyIndent()}  `)
        )) {
          out.push(`${line}\n`)
        }
      }
      if (!result.stdout && !result.stderr && !result.interrupted) {
        out.push(`${this.bodyIndent()}${chalk.dim('(no output)')}\n`)
      }
      return out
    }
    for (const line of this.truncate(formatToolOutput(result.output, this.bodyIndent()))) {
      out.push(`${line}\n`)
    }
    return out
  }

  private prefix(event: HrcLifecycleEvent, glyph: string, label: string): string {
    return `  ${chalk.dim(formatShortTime(event.ts))}  ${this.formatBadge(event.scopeRef)}  ${glyph} ${label}${this.eventMeta(event)}`
  }

  private eventMeta(event: HrcLifecycleEvent): string {
    const parts: string[] = []
    if (event.hrcSeq > 0) parts.push(`#${event.hrcSeq}`)
    if (event.replayed) parts.push('replayed')
    return parts.length > 0 ? `  ${chalk.dim(parts.join(' '))}` : ''
  }

  private formatBadge(scopeRef: string): string {
    const handle = formatCompactBadgeHandle(scopeRef)
    const display =
      handle.length > this.scopeWidth
        ? `${handle.slice(0, this.scopeWidth - 1)}.`
        : handle.padEnd(this.scopeWidth)
    return chalk.cyan(display)
  }

  private bodyIndent(): string {
    return `  ${' '.repeat(10)}${' '.repeat(this.scopeWidth)}    `
  }

  private truncate(lines: string[]): string[] {
    if (this.maxLines === 0 || lines.length <= this.maxLines) return lines
    const kept = lines.slice(0, this.maxLines)
    kept.push(
      `${this.bodyIndent()}${chalk.dim(`... (+${lines.length - this.maxLines} more lines; --max-lines 0 to expand)`)}`
    )
    return kept
  }
}

function toLifecycleEvent(event: MonitorRenderableEvent): HrcLifecycleEvent {
  const eventKind = stringField(event, 'eventKind') ?? stringField(event, 'event') ?? 'unknown'
  const seq = numberField(event, 'hrcSeq') ?? numberField(event, 'seq') ?? 0
  const laneRef = stringField(event, 'laneRef') ?? 'main'
  return {
    hrcSeq: seq,
    streamSeq: numberField(event, 'streamSeq') ?? seq,
    ts: stringField(event, 'ts') ?? new Date().toISOString(),
    hostSessionId: stringField(event, 'hostSessionId') ?? '',
    scopeRef: stringField(event, 'scopeRef') ?? stringField(event, 'selector') ?? '',
    laneRef,
    generation: numberField(event, 'generation') ?? 0,
    ...(stringField(event, 'runtimeId') ? { runtimeId: stringField(event, 'runtimeId') } : {}),
    ...((stringField(event, 'runId') ?? stringField(event, 'turnId'))
      ? { runId: stringField(event, 'runId') ?? stringField(event, 'turnId') }
      : {}),
    ...(stringField(event, 'launchId') ? { launchId: stringField(event, 'launchId') } : {}),
    category: categoryFrom(event, eventKind),
    eventKind,
    ...(transportFrom(event) ? { transport: transportFrom(event) } : {}),
    ...(stringField(event, 'errorCode') ? { errorCode: stringField(event, 'errorCode') } : {}),
    replayed: booleanField(event, 'replayed') ?? false,
    payload: payloadFrom(event),
  }
}

function categoryFrom(event: MonitorRenderableEvent, eventKind: string): HrcEventCategory {
  const explicit = stringField(event, 'category')
  if (isHrcEventCategory(explicit)) return explicit
  const prefix = eventKind.split('.')[0]
  return isHrcEventCategory(prefix) ? prefix : 'runtime'
}

function isHrcEventCategory(value: string | undefined): value is HrcEventCategory {
  return (
    value === 'session' ||
    value === 'runtime' ||
    value === 'launch' ||
    value === 'turn' ||
    value === 'inflight' ||
    value === 'surface' ||
    value === 'bridge' ||
    value === 'context' ||
    value === 'app_session'
  )
}

function transportFrom(event: MonitorRenderableEvent): HrcLifecycleEvent['transport'] | undefined {
  const transport = stringField(event, 'transport')
  return transport === 'sdk' || transport === 'tmux' || transport === 'headless'
    ? transport
    : undefined
}

function payloadFrom(event: MonitorRenderableEvent): unknown {
  if ('payload' in event) return event['payload']
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (
      [
        'seq',
        'hrcSeq',
        'streamSeq',
        'ts',
        'event',
        'eventKind',
        'selector',
        'sessionRef',
        'scopeRef',
        'laneRef',
        'hostSessionId',
        'generation',
        'runtimeId',
        'runId',
        'turnId',
        'launchId',
        'category',
        'transport',
        'replayed',
      ].includes(key)
    ) {
      continue
    }
    payload[key] = value
  }
  return payload
}

function toolCallFromEvent(event: HrcLifecycleEvent): PendingToolCall {
  const payload = asRecord(event.payload)
  return {
    event,
    toolUseId:
      stringField(payload ?? {}, 'toolUseId') ?? stringField(payload ?? {}, 'tool_use_id') ?? '',
    toolName:
      stringField(payload ?? {}, 'toolName') ?? stringField(payload ?? {}, 'tool_name') ?? 'tool',
    input: asRecord(payload?.['input']) ?? {},
  }
}

function isMatchingToolResult(event: HrcLifecycleEvent, pending: PendingToolCall): boolean {
  if (event.eventKind !== 'turn.tool_result') return false
  const payload = asRecord(event.payload)
  const toolUseId =
    stringField(payload ?? {}, 'toolUseId') ?? stringField(payload ?? {}, 'tool_use_id') ?? ''
  return toolUseId.length > 0 && toolUseId === pending.toolUseId
}

function formatToolTitle(toolName: string, input: Record<string, unknown>): string {
  const displayName = formatToolDisplayName(toolName)
  const summary = formatToolSummary(toolName, input)
  return summary ? `${displayName} - ${summary}` : displayName
}

function formatToolDisplayName(toolName: string): string {
  if (toolName === 'exec_command' || toolName === 'command_execution') return 'Bash'
  if (toolName === 'file_change') return 'FileChange'
  if (toolName === 'web_search') return 'WebSearch'
  if (toolName === 'image_view') return 'ImageView'
  return toolName
}

function formatToolSummary(toolName: string, input: Record<string, unknown>): string | undefined {
  const description = stringField(input, 'description')
  if (description) return truncateText(description, 80)

  if (isShellTool(toolName)) {
    const cwd = stringField(input, 'cwd') ?? stringField(input, 'workdir')
    return cwd ? `cwd ${compactPath(cwd)}` : undefined
  }

  if (toolName === 'Read') {
    const path = stringField(input, 'file_path') ?? stringField(input, 'path')
    return path ? compactPath(path) : undefined
  }

  if (toolName === 'Write' || toolName === 'Edit') {
    const path = stringField(input, 'file_path') ?? stringField(input, 'path')
    return path ? compactPath(path) : undefined
  }

  if (toolName === 'TaskUpdate') {
    const taskId = stringField(input, 'taskId') ?? stringField(input, 'task_id')
    const status = stringField(input, 'status')
    return (
      [taskId, status].filter((part): part is string => part !== undefined).join(' ') || undefined
    )
  }

  if (toolName === 'file_change') {
    const changes = input['changes']
    return Array.isArray(changes)
      ? `${changes.length} change${changes.length === 1 ? '' : 's'}`
      : undefined
  }

  if (toolName.startsWith('mcp:')) {
    const tool = stringField(input, 'tool')
    return tool ? truncateText(tool, 80) : undefined
  }

  if (toolName === 'web_search' || toolName === 'WebSearch') {
    const query = stringField(input, 'query')
    return query ? truncateText(query, 80) : undefined
  }

  if (toolName === 'image_view') {
    const path = stringField(input, 'path')
    return path ? compactPath(path) : undefined
  }

  return undefined
}

function formatToolCallBody(toolName: string, input: Record<string, unknown>): string[] {
  if (isShellTool(toolName)) return formatShellCommand(input)
  if (toolName === 'Read') return formatReadInput(input)
  if (toolName === 'Write') return formatWriteInput(input)
  if (toolName === 'Edit') return formatEditInput(input)
  if (toolName === 'TaskUpdate') return formatTaskUpdateInput(input)
  if (toolName === 'file_change') return formatFileChangeInput(input)
  return formatGenericToolInput(input)
}

function isShellTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'exec_command' || toolName === 'command_execution'
}

function formatShellCommand(input: Record<string, unknown>): string[] {
  const raw = input['command'] ?? input['cmd']
  if (Array.isArray(raw)) {
    const command = raw.map((part) => String(part))
    if (command[0] === 'bash' && command[1] === '-lc' && command[2]) return [`$ ${command[2]}`]
    return [`$ ${command.join(' ')}`]
  }
  if (typeof raw === 'string') return [`$ ${raw}`]
  return formatGenericToolInput(input)
}

function formatReadInput(input: Record<string, unknown>): string[] {
  const out: string[] = []
  const path = stringField(input, 'file_path') ?? stringField(input, 'path')
  if (path) out.push(compactPath(path))
  const offset = numberField(input, 'offset')
  const limit = numberField(input, 'limit')
  const range = [
    offset !== undefined ? `offset ${offset}` : undefined,
    limit !== undefined ? `limit ${limit}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ')
  if (range) out.push(range)
  return out.length > 0 ? out : formatGenericToolInput(input)
}

function formatWriteInput(input: Record<string, unknown>): string[] {
  const out: string[] = []
  const path = stringField(input, 'file_path') ?? stringField(input, 'path')
  if (path) out.push(compactPath(path))
  const content = stringField(input, 'content')
  if (content !== undefined)
    out.push(`write ${countLines(content)} line${countLines(content) === 1 ? '' : 's'}`)
  return out.length > 0 ? out : formatGenericToolInput(input)
}

function formatEditInput(input: Record<string, unknown>): string[] {
  const out: string[] = []
  const path = stringField(input, 'file_path') ?? stringField(input, 'path')
  if (path) out.push(compactPath(path))
  const oldString = stringField(input, 'old_string')
  const newString = stringField(input, 'new_string')
  if (oldString !== undefined || newString !== undefined) {
    out.push(booleanField(input, 'replace_all') ? 'replace all matches' : 'replace one block')
    if (oldString !== undefined)
      out.push(`old: ${countLines(oldString)} line${countLines(oldString) === 1 ? '' : 's'}`)
    if (newString !== undefined)
      out.push(`new: ${countLines(newString)} line${countLines(newString) === 1 ? '' : 's'}`)
  }
  return out.length > 0 ? out : formatGenericToolInput(input)
}

function formatTaskUpdateInput(input: Record<string, unknown>): string[] {
  const taskId = stringField(input, 'taskId') ?? stringField(input, 'task_id')
  const status = stringField(input, 'status')
  const out = [
    taskId ? `task ${taskId}` : undefined,
    status ? `status ${status}` : undefined,
  ].filter((part): part is string => part !== undefined)
  return out.length > 0 ? out : formatGenericToolInput(input)
}

function formatFileChangeInput(input: Record<string, unknown>): string[] {
  const changes = input['changes']
  if (!Array.isArray(changes)) return formatGenericToolInput(input)
  return changes.map((change, index) => {
    const record = asRecord(change)
    const path = stringField(record ?? {}, 'path') ?? stringField(record ?? {}, 'file')
    const type = stringField(record ?? {}, 'type') ?? stringField(record ?? {}, 'status')
    const label = [type, path ? compactPath(path) : undefined]
      .filter((part): part is string => part !== undefined)
      .join(' ')
    return label || `change ${index + 1}`
  })
}

function formatGenericToolInput(input: Record<string, unknown>): string[] {
  return Object.keys(input).length > 0 ? [JSON.stringify(input)] : []
}

function formatToolResultLabel(result: ParsedToolResult): string {
  if (result.interrupted) return 'interrupted'
  if (result.exitCode !== undefined) return result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`
  if (result.isError === true) return 'error'
  if (result.isError === false) return 'ok'
  return 'result'
}

function parseToolResult(payload: unknown): ParsedToolResult {
  const payloadRecord = asRecord(payload)
  const resultRecord = asRecord(payloadRecord?.['result'])
  const details = asRecord(resultRecord?.['details'])
  const isError = booleanField(payloadRecord ?? {}, 'isError')
  const stdout = stringField(details ?? {}, 'stdout')
  const stderr = stringField(details ?? {}, 'stderr')
  const interrupted = booleanField(details ?? {}, 'interrupted')
  const detailsExitCode =
    numberField(details ?? {}, 'exitCode') ?? numberField(details ?? {}, 'exit_code')
  const detailsDuration =
    numberField(details ?? {}, 'durationSeconds') ??
    numberField(details ?? {}, 'duration_seconds') ??
    millisToSeconds(
      numberField(details ?? {}, 'durationMs') ?? numberField(payloadRecord ?? {}, 'durationMs')
    )
  if (stdout !== undefined || stderr !== undefined || interrupted !== undefined) {
    return {
      output: [stdout, stderr].filter((part): part is string => Boolean(part)).join('\n'),
      ...(stdout !== undefined ? { stdout } : {}),
      ...(stderr !== undefined ? { stderr } : {}),
      ...(interrupted !== undefined ? { interrupted } : {}),
      ...(detailsExitCode !== undefined ? { exitCode: detailsExitCode } : {}),
      ...(detailsDuration !== undefined ? { durationSeconds: detailsDuration } : {}),
      ...(isError !== undefined ? { isError } : {}),
    }
  }

  const text = extractToolResultText(payloadRecord)
  const json = parseJsonObject(text)
  const metadata = asRecord(json?.['metadata'])
  if (json && typeof json['output'] === 'string') {
    return {
      output: json['output'],
      ...(typeof metadata?.['exit_code'] === 'number' ? { exitCode: metadata['exit_code'] } : {}),
      ...(typeof metadata?.['duration_seconds'] === 'number'
        ? { durationSeconds: metadata['duration_seconds'] }
        : {}),
      ...(isError !== undefined ? { isError } : {}),
    }
  }
  const codex = parseCodexExecOutput(text)
  if (codex) return { ...codex, ...(isError !== undefined ? { isError } : {}) }
  return { output: text, ...(isError !== undefined ? { isError } : {}) }
}

function parseCodexExecOutput(text: string): ParsedToolResult | undefined {
  const marker = '\nOutput:\n'
  const idx = text.indexOf(marker)
  if (idx === -1) return undefined
  const preamble = text.slice(0, idx)
  const exitMatch = preamble.match(/Process exited with code (\d+)/)
  const durationMatch = preamble.match(/Wall time: ([0-9.]+) seconds/)
  return {
    output: text.slice(idx + marker.length),
    ...(exitMatch?.[1] ? { exitCode: Number(exitMatch[1]) } : {}),
    ...(durationMatch?.[1] ? { durationSeconds: Number(durationMatch[1]) } : {}),
  }
}

function formatToolOutput(text: string, indent: string): string[] {
  const json = parseJsonObject(text.trim())
  if (json) return renderPrettyValue(json, indent)
  return wrapBody(text, indent)
}

function extractToolResultText(payload: Record<string, unknown> | null | undefined): string {
  const result = asRecord(payload?.['result'])
  const content = result?.['content']
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const record = asRecord(item)
        return typeof record?.['text'] === 'string' ? record['text'] : ''
      })
      .join('')
  }
  if (typeof payload?.['message'] === 'string') return payload['message']
  if (typeof payload?.['partialOutput'] === 'string') return payload['partialOutput']
  return typeof payload?.['result'] === 'string' ? payload['result'] : JSON.stringify(payload ?? {})
}

function extractMessageRole(payload: unknown): string {
  const record = asRecord(payload)
  const message = asRecord(record?.['message'])
  return stringField(message ?? {}, 'role') ?? stringField(record ?? {}, 'role') ?? 'assistant'
}

function extractMessageContent(payload: unknown): string {
  const record = asRecord(payload)
  const message = asRecord(record?.['message'])
  const content =
    message?.['content'] ?? record?.['content'] ?? record?.['text'] ?? record?.['message']
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const item = asRecord(part)
        return typeof item?.['text'] === 'string' ? item['text'] : ''
      })
      .join('')
  }
  return content === undefined ? '' : JSON.stringify(content)
}

function inlinePayload(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'type' || !isInlinePrimitive(value)) continue
    parts.push(`${chalk.dim(key)}=${formatInlineValue(value)}`)
  }
  return parts.length > 0 ? `  ${parts.join(chalk.dim(' * '))}` : ''
}

function renderPrettyValue(value: unknown, indent: string): string[] {
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

function wrapBody(text: string, indent: string): string[] {
  if (!text) return []
  return text.split('\n').map((line) => `${indent}${line}`)
}

function glyphFor(event: HrcLifecycleEvent): string {
  if (event.eventKind.includes('failed') || event.eventKind.includes('dead')) return chalk.red('!')
  if (event.eventKind.includes('completed') || event.eventKind.includes('finished'))
    return chalk.green('v')
  if (event.eventKind.startsWith('session.')) return chalk.blue('*')
  if (event.eventKind.startsWith('runtime.')) return chalk.cyan('*')
  return chalk.blue('*')
}

function formatAgentHandle(scopeRef: string): string | undefined {
  try {
    const parsed = parseScopeRef(scopeRef)
    const base = parsed.projectId ? `${parsed.agentId}@${parsed.projectId}` : parsed.agentId
    return parsed.taskId ? `${base}:${parsed.taskId}` : base
  } catch {
    return undefined
  }
}

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

function shortId(id: string, _prefix: string): string {
  const dashIdx = id.indexOf('-')
  if (dashIdx === -1) return id
  return `${id.slice(0, dashIdx)}-${id.slice(dashIdx + 1, dashIdx + 8)}`
}

function formatShortTime(ts: string): string {
  return ts.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? ts
}

function formatLongTime(ts: string): string {
  return ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text)
    return asRecord(parsed) ?? undefined
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isInlinePrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function formatInlineValue(value: string | number | boolean | null): string {
  if (value === null) return chalk.dim('null')
  if (typeof value === 'boolean') return value ? chalk.green('true') : chalk.red('false')
  if (typeof value === 'number') return chalk.white(String(value))
  return chalk.white(value)
}

function compactPath(path: string): string {
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

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}.` : value
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').length
}

function millisToSeconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value / 1000
}

function stringField(event: Record<string, unknown>, key: string): string | undefined {
  const value = event[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(event: Record<string, unknown>, key: string): number | undefined {
  const value = event[key]
  return typeof value === 'number' ? value : undefined
}

function booleanField(event: Record<string, unknown>, key: string): boolean | undefined {
  const value = event[key]
  return typeof value === 'boolean' ? value : undefined
}

function stripAnsi(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC.
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}
