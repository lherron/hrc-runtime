import { createLogger } from './logger.js'
import type {
  GatewaySessionEvent,
  PermissionAction,
  RenderFrame,
  SessionEventEnvelope,
} from './types.js'

const log = createLogger({ component: 'hrc-frame-render' })

const TITLE_MAX_LEN = 100
const TOOL_SUMMARY_MAX_LEN = 80
const EMPTY_JSON_LEN = 2

type MediaRef = {
  url: string
  mimeType?: string | undefined
  filename?: string | undefined
  alt?: string | undefined
}

type ToolResultContentBlock = {
  type: string
  text?: string | undefined
  data?: string | undefined
  mimeType?: string | undefined
  url?: string | undefined
  filename?: string | undefined
  alt?: string | undefined
}

interface ToolExecution {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  status: 'running' | 'completed' | 'failed'
  seq: number
  output?: string | undefined
  images?: Array<{ data: string; mimeType: string }> | undefined
  mediaRefs?: MediaRef[] | undefined
}

export interface AssistantSegment {
  id: string
  seq: number
  text: string
}

export interface RunState {
  runId: string
  projectId: string
  lastSeq: number
  status: 'queued' | 'running' | 'awaiting_permission' | 'completed' | 'failed' | 'cancelled'
  inputContent: string
  startedAt?: number | undefined
  completedAt?: number | undefined
  userMessage?: string | undefined
  assistantSegments: AssistantSegment[]
  activeAssistantSegmentId?: string | undefined
  currentAssistantMessageRef?: string | undefined
  toolExecutions: ToolExecution[]
  noticeEntries: Array<{
    id: string
    level: 'info' | 'warn' | 'error'
    message: string
    seq: number
  }>
  permissionRequest?:
    | {
        requestId: string
        toolUseId: string
        toolName: string
        toolInput: Record<string, unknown>
        actions: PermissionAction[]
      }
    | undefined
}

interface ProjectState {
  projectId: string
  runs: Map<string, RunState>
  focusedRunId?: string | undefined
}

type AssistantSegmentMode = 'append' | 'replace' | 'set'

class AssistantSegmentBuffer {
  constructor(private readonly run: RunState) {}

  get length(): number {
    return this.run.assistantSegments.length
  }

  closeActive(): void {
    this.run.activeAssistantSegmentId = undefined
  }

  clearCurrentMessageRef(): void {
    this.run.currentAssistantMessageRef = undefined
  }

  clearCurrentMessageRefIf(ref: string | undefined): void {
    if (ref !== undefined && ref === this.run.currentAssistantMessageRef) {
      this.run.currentAssistantMessageRef = undefined
    }
  }

  startMessage(ref: string, seq: number, text: string): void {
    this.closeActive()
    this.run.currentAssistantMessageRef = ref
    this.upsert({ id: ref, seq, text, mode: 'set' })
  }

  appendDelta(ref: string | undefined, seq: number, text: string): void {
    this.upsert({ id: ref, seq, text, mode: 'append' })
    this.captureActiveRefWhenAnonymous(ref)
  }

  replaceBody(ref: string | undefined, seq: number, text: string): void {
    this.upsert({ id: ref, seq, text, mode: 'replace' })
    this.captureActiveRefWhenAnonymous(ref)
  }

  setFinal(seq: number, text: string): void {
    this.upsert({ id: undefined, seq, text, mode: 'set', close: true })
  }

  endMessage(ref: string | undefined, seq: number, text: string): void {
    if (ref === undefined && this.run.assistantSegments.length > 0) {
      this.closeActive()
      return
    }

    this.upsert({ id: ref, seq, text, mode: 'replace', close: true })
  }

  closeExisting(ref: string | undefined): void {
    if (ref === undefined) {
      return
    }

    const idx = this.run.assistantSegments.findIndex((s) => s.id === ref)
    if (idx >= 0) {
      this.run.activeAssistantSegmentId = undefined
    }
  }

  private captureActiveRefWhenAnonymous(ref: string | undefined): void {
    if (ref === undefined && this.run.activeAssistantSegmentId !== undefined) {
      this.run.currentAssistantMessageRef = this.run.activeAssistantSegmentId
    }
  }

  private upsert(options: {
    id: string | undefined
    seq: number
    text: string
    mode: AssistantSegmentMode
    close?: boolean
  }): void {
    const { id: rawId, seq: segSeq, text, mode, close = false } = options
    if (rawId !== undefined) {
      const idx = this.run.assistantSegments.findIndex((s) => s.id === rawId)
      if (idx >= 0) {
        const existing = this.run.assistantSegments[idx]
        if (existing) {
          this.run.assistantSegments[idx] = {
            ...existing,
            text: mode === 'append' ? existing.text + text : text,
          }
        }
        this.run.activeAssistantSegmentId = close ? undefined : rawId
        return
      }
    }

    if (
      mode === 'append' &&
      this.run.activeAssistantSegmentId !== undefined &&
      rawId === undefined
    ) {
      const idx = this.run.assistantSegments.findIndex(
        (s) => s.id === this.run.activeAssistantSegmentId
      )
      const existing = idx >= 0 ? this.run.assistantSegments[idx] : undefined
      if (existing) {
        this.run.assistantSegments[idx] = { ...existing, text: existing.text + text }
        if (close) this.run.activeAssistantSegmentId = undefined
        return
      }
    }

    if (
      mode === 'replace' &&
      rawId === undefined &&
      this.run.activeAssistantSegmentId !== undefined
    ) {
      const idx = this.run.assistantSegments.findIndex(
        (s) => s.id === this.run.activeAssistantSegmentId
      )
      const existing = idx >= 0 ? this.run.assistantSegments[idx] : undefined
      if (existing) {
        this.run.assistantSegments[idx] = { ...existing, text }
        if (close) this.run.activeAssistantSegmentId = undefined
        return
      }
    }

    const newId = rawId ?? `seg-${segSeq}`
    this.run.assistantSegments.push({ id: newId, seq: segSeq, text })
    this.run.activeAssistantSegmentId = close ? undefined : newId
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
    )
    .map((block) => block.text)
    .join('')
}

function flattenMessageContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') {
    return content
  }
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('')
}

function extractTurnEndAssistantMessage(payload: unknown): string | undefined {
  const record = isRecord(payload) ? payload : {}
  const finalOutput = record['finalOutput']
  if (typeof finalOutput === 'string' && finalOutput.trim().length > 0) {
    return finalOutput
  }

  const content = record['content']
  if (typeof content === 'string' && content.trim().length > 0) {
    return content
  }

  const message = record['message']
  if (!isRecord(message) || message['role'] !== 'assistant') {
    return undefined
  }

  const text = extractTextContent(message['content'])
  return text.trim().length > 0 ? text : undefined
}

function eventUsesContextRun(event: GatewaySessionEvent): boolean {
  switch (event.type) {
    case 'message_start':
    case 'message_end':
    case 'message_update':
    case 'turn_end':
    case 'tool_execution_start':
    case 'tool_execution_end':
    case 'notice':
      return true
    default:
      return false
  }
}

function processEvent(
  state: ProjectState,
  event: GatewaySessionEvent,
  runId: string | undefined,
  seq: number
): ProjectState {
  const newState = { ...state, runs: new Map(state.runs) }

  const getOrCreateRun = (rid: string): RunState => {
    const existing = newState.runs.get(rid)
    if (existing) {
      return {
        ...existing,
        toolExecutions: existing.toolExecutions.map((tool) => ({
          ...tool,
          ...(tool.images ? { images: [...tool.images] } : {}),
          ...(tool.mediaRefs ? { mediaRefs: [...tool.mediaRefs] } : {}),
        })),
        noticeEntries: existing.noticeEntries.map((notice) => ({ ...notice })),
        assistantSegments: existing.assistantSegments.map((seg) => ({ ...seg })),
      }
    }

    return {
      runId: rid,
      projectId: state.projectId,
      lastSeq: 0,
      status: 'queued',
      inputContent: '',
      toolExecutions: [],
      noticeEntries: [],
      assistantSegments: [],
    }
  }

  if (eventUsesContextRun(event) && !runId) {
    return newState
  }

  switch (event.type) {
    case 'run_queued': {
      const run = getOrCreateRun(event.runId)
      run.lastSeq = seq
      run.projectId = event.projectId
      run.status = 'queued'
      run.inputContent = event.input.content
      newState.runs.set(event.runId, run)
      newState.focusedRunId = event.runId
      break
    }

    case 'run_started': {
      const run = getOrCreateRun(event.runId)
      run.lastSeq = seq
      run.status = 'running'
      run.startedAt = event.startedAt
      newState.runs.set(event.runId, run)
      newState.focusedRunId = event.runId
      break
    }

    case 'run_completed': {
      const run = getOrCreateRun(event.runId)
      run.lastSeq = seq
      run.status = 'completed'
      run.completedAt = event.completedAt
      if (event.finalOutput && run.assistantSegments.length === 0) {
        new AssistantSegmentBuffer(run).setFinal(seq, event.finalOutput)
      }
      run.currentAssistantMessageRef = undefined
      newState.runs.set(event.runId, run)
      break
    }

    case 'run_failed': {
      const run = getOrCreateRun(event.runId)
      run.lastSeq = seq
      run.status = 'failed'
      newState.runs.set(event.runId, run)
      break
    }

    case 'run_cancelled': {
      const run = getOrCreateRun(event.runId)
      run.lastSeq = seq
      run.status = 'cancelled'
      newState.runs.set(event.runId, run)
      break
    }

    case 'message_start': {
      const contextRunId = runId as string
      const run = getOrCreateRun(contextRunId)
      run.lastSeq = seq
      const segments = new AssistantSegmentBuffer(run)
      const message = event.message
      const messageId = event.messageId
      if (message) {
        const content = flattenMessageContent(message.content)

        if (message.role === 'user') {
          run.userMessage = content
        } else if (message.role === 'assistant') {
          const ref = messageId ?? `seg-${seq}`
          segments.startMessage(ref, seq, content)
        }
      } else if (messageId !== undefined) {
        segments.startMessage(messageId, seq, '')
      }

      newState.runs.set(contextRunId, run)
      break
    }

    case 'message_end': {
      const contextRunId = runId as string
      const run = getOrCreateRun(contextRunId)
      run.lastSeq = seq
      const segments = new AssistantSegmentBuffer(run)
      const message = event.message
      const messageId = event.messageId
      const targetRef = messageId ?? run.currentAssistantMessageRef
      if (message) {
        const content = flattenMessageContent(message.content)

        if (message.role === 'user') {
          run.userMessage = content
        } else if (message.role === 'assistant') {
          segments.endMessage(targetRef, seq, content)
        }
      } else if (targetRef !== undefined) {
        segments.closeExisting(targetRef)
      }
      segments.clearCurrentMessageRefIf(targetRef)

      newState.runs.set(contextRunId, run)
      break
    }

    case 'message_update': {
      const contextRunId = runId as string
      const run = getOrCreateRun(contextRunId)
      run.lastSeq = seq
      const segments = new AssistantSegmentBuffer(run)
      const targetRef = event.messageId ?? run.currentAssistantMessageRef

      if (event.textDelta) {
        segments.appendDelta(targetRef, seq, event.textDelta)
      }

      if (event.contentBlocks) {
        const textContent = event.contentBlocks
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text)
          .join('')

        if (textContent) {
          segments.replaceBody(targetRef, seq, textContent)
        }
      }

      newState.runs.set(contextRunId, run)
      break
    }

    case 'turn_end': {
      const contextRunId = runId as string
      const run = getOrCreateRun(contextRunId)
      run.lastSeq = seq
      run.status = 'completed'
      run.completedAt = Date.now()
      const segments = new AssistantSegmentBuffer(run)
      const completedMessage = extractTurnEndAssistantMessage(event.payload)
      if (completedMessage !== undefined && segments.length === 0) {
        segments.setFinal(seq, completedMessage)
      } else {
        segments.closeActive()
      }
      run.currentAssistantMessageRef = undefined
      newState.runs.set(contextRunId, run)
      break
    }

    case 'tool_execution_start': {
      const contextRunId = runId as string
      const run = getOrCreateRun(contextRunId)
      run.lastSeq = seq
      new AssistantSegmentBuffer(run).closeActive()
      const existingIndex = run.toolExecutions.findIndex(
        (tool) => tool.toolUseId === event.toolUseId
      )

      if (existingIndex >= 0) {
        const existingTool = run.toolExecutions[existingIndex]
        if (!existingTool) {
          break
        }

        run.toolExecutions[existingIndex] = {
          ...existingTool,
          status: 'running',
        }
      } else {
        run.toolExecutions.push({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          seq,
          status: 'running',
        })
      }

      newState.runs.set(contextRunId, run)
      break
    }

    case 'tool_execution_end': {
      const contextRunId = runId as string
      const run = getOrCreateRun(contextRunId)
      run.lastSeq = seq
      const toolIndex = run.toolExecutions.findIndex((tool) => tool.toolUseId === event.toolUseId)
      let output = ''
      const images: Array<{ data: string; mimeType: string }> = []
      const mediaRefs: MediaRef[] = []

      const result = event.result as {
        content?: ToolResultContentBlock[]
        details?:
          | {
              content?: ToolResultContentBlock[]
            }
          | undefined
      }

      const contentBlocks = result.content ?? result.details?.content ?? []
      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          output += block.text
        } else if (block.type === 'image' && block.data && block.mimeType) {
          images.push({ data: block.data, mimeType: block.mimeType })
        } else if (block.type === 'media_ref' && block.url) {
          mediaRefs.push({
            url: block.url,
            mimeType: block.mimeType,
            filename: block.filename,
            alt: block.alt,
          })
        }
      }

      const status: ToolExecution['status'] = event.isError ? 'failed' : 'completed'

      if (toolIndex >= 0) {
        const existingTool = run.toolExecutions[toolIndex]
        if (!existingTool) {
          break
        }

        run.toolExecutions[toolIndex] = {
          ...existingTool,
          status,
          output: output || existingTool.output || '',
          images: images.length > 0 ? images : existingTool.images,
          mediaRefs: mediaRefs.length > 0 ? mediaRefs : existingTool.mediaRefs,
        }
      } else {
        run.toolExecutions.push({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: {},
          seq,
          status,
          output: output || '',
          images: images.length > 0 ? images : undefined,
          mediaRefs: mediaRefs.length > 0 ? mediaRefs : undefined,
        })
      }

      newState.runs.set(contextRunId, run)
      break
    }

    case 'permission_request': {
      const run = getOrCreateRun(event.runId)
      run.lastSeq = seq
      run.status = 'awaiting_permission'
      run.permissionRequest = {
        requestId: event.requestId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        toolInput: event.toolInput,
        actions: event.actions,
      }
      newState.runs.set(event.runId, run)
      break
    }

    case 'permission_decision': {
      const run = getOrCreateRun(event.runId)
      run.lastSeq = seq
      run.permissionRequest = undefined
      if (run.status === 'awaiting_permission') {
        run.status = 'running'
      }
      newState.runs.set(event.runId, run)
      break
    }

    case 'notice': {
      const contextRunId = runId as string
      const run = getOrCreateRun(contextRunId)
      run.lastSeq = seq
      run.noticeEntries.push({
        id: String(seq),
        level: event.level,
        message: event.message,
        seq,
      })
      newState.runs.set(contextRunId, run)
      break
    }

    default:
      // Session-metadata events (and any other unhandled types) are known-but-ignored.
      break
  }

  return newState
}

const STATUS_TO_PHASE: Record<RunState['status'], RenderFrame['phase']> = {
  queued: 'queued',
  awaiting_permission: 'permission',
  running: 'progress',
  completed: 'final',
  failed: 'error',
  cancelled: 'error',
}

const PHASE_EMOJI: Record<RenderFrame['phase'], string> = {
  queued: '⚙️',
  progress: '⚙️',
  permission: '🔐',
  final: '✅',
  error: '❌',
}

function titleFor(phase: RenderFrame['phase'], inputContent: string): string {
  const emoji = PHASE_EMOJI[phase]
  const trimmed = inputContent.trim()
  if (trimmed.length === 0) {
    return emoji
  }
  const oneLine = trimmed.replace(/\s+/g, ' ')
  const truncated =
    oneLine.length > TITLE_MAX_LEN ? `${oneLine.slice(0, TITLE_MAX_LEN)}...` : oneLine
  return `${emoji} ${truncated}`
}

function formatToolSummary(toolInput: Record<string, unknown>): string {
  const truncate = (value: string, max: number) =>
    value.length > max ? `${value.slice(0, max)}...` : value

  for (const value of Object.values(toolInput)) {
    if (typeof value === 'string' && value.length > 0) {
      return `\`${truncate(value, TOOL_SUMMARY_MAX_LEN)}\``
    }
  }

  const json = JSON.stringify(toolInput)
  return json.length > EMPTY_JSON_LEN ? truncate(json, TOOL_SUMMARY_MAX_LEN) : ''
}

type TimelineEntry = { seq: number; block: RenderFrame['blocks'][number] }

function toolBlocks(run: RunState): TimelineEntry[] {
  return run.toolExecutions.map((tool) => ({
    seq: tool.seq,
    block: {
      t: 'tool',
      toolName: tool.toolName,
      summary: formatToolSummary(tool.input),
      input: tool.input,
      output: tool.output,
      images: tool.images,
      approved: tool.status === 'completed' ? true : tool.status === 'failed' ? false : undefined,
    },
  }))
}

function collectMediaRefs(run: RunState): MediaRef[] {
  const allMediaRefs: MediaRef[] = []
  for (const tool of run.toolExecutions) {
    if (tool.mediaRefs && tool.mediaRefs.length > 0) {
      allMediaRefs.push(...tool.mediaRefs)
    }
  }
  return allMediaRefs
}

function noticeBlocks(run: RunState): TimelineEntry[] {
  return run.noticeEntries.map((notice) => ({
    seq: notice.seq,
    block: {
      t: 'notice',
      level: notice.level,
      message: notice.message,
    },
  }))
}

function segmentBlocks(run: RunState): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  for (const seg of run.assistantSegments) {
    if (seg.text.length === 0) continue
    entries.push({
      seq: seg.seq,
      block: { t: 'markdown', md: seg.text },
    })
  }
  return entries
}

function permissionBlock(run: RunState): RenderFrame['blocks'][number] | undefined {
  if (!run.permissionRequest) {
    return undefined
  }
  const { toolName, toolInput } = run.permissionRequest
  const command = toolInput['command']
  if (toolName === 'Bash' && typeof command === 'string') {
    return { t: 'code', lang: 'bash', code: command }
  }
  return {
    t: 'code',
    lang: 'json',
    code: JSON.stringify(toolInput, null, 2),
  }
}

function progressPlaceholder(
  run: RunState,
  phase: RenderFrame['phase'],
  hasSegments: boolean
): RenderFrame['blocks'][number] | undefined {
  if (hasSegments || phase !== 'progress') {
    return undefined
  }
  const runningTool = run.toolExecutions.find((tool) => tool.status === 'running')
  if (runningTool) {
    return {
      t: 'markdown',
      md: formatToolSummary(runningTool.input),
    }
  }
  return { t: 'markdown', md: '...' }
}

function mediaRefBlocks(run: RunState): RenderFrame['blocks'] {
  return collectMediaRefs(run).map((media) => ({
    t: 'media_ref',
    url: media.url,
    mimeType: media.mimeType,
    filename: media.filename,
    alt: media.alt,
  }))
}

function buildOrderedBlocks(run: RunState, phase: RenderFrame['phase']): RenderFrame['blocks'] {
  const timelineBlocks = [...toolBlocks(run), ...noticeBlocks(run)]
  const segments = segmentBlocks(run)

  const blocks: RenderFrame['blocks'] = [...timelineBlocks, ...segments]
    .sort((left, right) => left.seq - right.seq)
    .map((entry) => entry.block)

  const permission = permissionBlock(run)
  if (permission) {
    blocks.push(permission)
  }

  const placeholder = progressPlaceholder(run, phase, segments.length > 0)
  if (placeholder) {
    blocks.push(placeholder)
  }

  blocks.push(...mediaRefBlocks(run))

  return blocks
}

function buildActions(run: RunState): RenderFrame['actions'] {
  return run.permissionRequest?.actions.map((action) => ({
    id: action.id,
    kind: action.kind,
    label: action.label,
    style: action.style,
  }))
}

export function runStateToFrame(run: RunState): RenderFrame {
  const phase = STATUS_TO_PHASE[run.status]

  const blocks = buildOrderedBlocks(run, phase)
  const actions = buildActions(run)

  return {
    runId: run.runId,
    projectId: run.projectId,
    phase,
    title: titleFor(phase, run.inputContent),
    blocks: blocks.length > 0 ? blocks : [{ t: 'markdown', md: '...' }],
    ...(actions ? { actions } : {}),
    statusLine: run.status,
    updatedAt: Date.now(),
  }
}

export type OnRenderCallback = (
  sessionRef: string,
  projectId: string,
  runId: string,
  frame: RenderFrame,
  run: RunState
) => void

export type OnRunQueuedCallback = (projectId: string, runId: string, inputContent: string) => void

export class SessionEventsManager {
  private readonly gatewayId: string
  private readonly onRender: OnRenderCallback
  private readonly sessions = new Map<string, ProjectState>()

  constructor(gatewayId: string, onRender: OnRenderCallback) {
    this.gatewayId = gatewayId
    this.onRender = onRender
  }

  subscribe(sessionRef: string, projectId: string): void {
    if (!this.sessions.has(sessionRef)) {
      this.sessions.set(sessionRef, {
        projectId,
        runs: new Map(),
      })
    }
  }

  unsubscribe(sessionRef: string): void {
    this.sessions.delete(sessionRef)
  }

  receive(envelope: SessionEventEnvelope): void {
    if (!envelope.sessionRef) {
      log.warn('session.event.dropped', {
        message: 'Dropping session event without canonical session identity',
        trace: { gatewayId: this.gatewayId, projectId: envelope.projectId, runId: envelope.runId },
        data: { eventType: envelope.event.type },
      })
      return
    }

    const state = this.ensureSession(envelope.sessionRef, envelope.projectId)
    const affectedRunId = this.getAffectedRunId(envelope.event, envelope.runId)
    const existingRun = affectedRunId ? state.runs.get(affectedRunId) : undefined
    const seq = envelope.seq ?? (existingRun?.lastSeq ?? 0) + 1
    const isInternal = envelope.run?.visibility === 'internal'

    if (existingRun && seq <= existingRun.lastSeq) {
      log.debug('session.event.dedupe', {
        message: `Ignoring duplicate event: ${envelope.event.type}`,
        trace: {
          gatewayId: this.gatewayId,
          projectId: envelope.projectId,
          sessionRef: envelope.sessionRef,
          runId: envelope.runId,
        },
        data: { eventType: envelope.event.type, seq, lastSeq: existingRun.lastSeq },
      })
      return
    }

    if (isInternal) {
      return
    }

    log.info('session.event.received', {
      message: `Received event: ${envelope.event.type}`,
      trace: {
        gatewayId: this.gatewayId,
        projectId: envelope.projectId,
        sessionRef: envelope.sessionRef,
        runId: envelope.runId,
      },
      data: { eventType: envelope.event.type, seq },
    })

    this.processAndEmit(
      envelope.sessionRef,
      envelope.projectId,
      envelope.event,
      envelope.runId,
      seq
    )
  }

  getRunState(sessionRef: string, runId: string): RunState | undefined {
    return this.sessions.get(sessionRef)?.runs.get(runId)
  }

  private ensureSession(sessionRef: string, projectId: string): ProjectState {
    const existing = this.sessions.get(sessionRef)
    if (existing) {
      return existing
    }

    const created: ProjectState = {
      projectId,
      runs: new Map(),
    }
    this.sessions.set(sessionRef, created)
    return created
  }

  private processAndEmit(
    sessionRef: string,
    projectId: string,
    event: GatewaySessionEvent,
    runId: string | undefined,
    seq: number
  ): void {
    const state = this.ensureSession(sessionRef, projectId)
    const newState = processEvent(state, event, runId, seq)
    this.sessions.set(sessionRef, newState)

    const affectedRunId = this.getAffectedRunId(event, runId)
    if (!affectedRunId) {
      return
    }

    const run = newState.runs.get(affectedRunId)
    if (!run) {
      return
    }

    this.onRender(sessionRef, projectId, affectedRunId, runStateToFrame(run), run)
  }

  private getAffectedRunId(
    event: GatewaySessionEvent,
    contextRunId?: string | undefined
  ): string | undefined {
    switch (event.type) {
      case 'run_queued':
      case 'run_started':
      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled':
      case 'permission_request':
      case 'permission_decision':
        return event.runId
      default:
        return contextRunId
    }
  }
}
