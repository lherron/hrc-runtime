import { createLogger } from './logger.js'
import { SESSION_METADATA_EVENT_TYPES } from './types.js'
import type {
  GatewaySessionEvent,
  PermissionAction,
  RenderFrame,
  SessionEventEnvelope,
} from './types.js'

const log = createLogger({ component: 'hrc-frame-render' })

interface ToolExecution {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  status: 'running' | 'completed' | 'failed'
  seq: number
  output?: string | undefined
  images?: Array<{ data: string; mimeType: string }> | undefined
  mediaRefs?:
    | Array<{
        url: string
        mimeType?: string | undefined
        filename?: string | undefined
        alt?: string | undefined
      }>
    | undefined
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
  /**
   * Opaque sink-specific metadata. Sinks (e.g. Discord, terminal) can stash
   * their own tracking state here without the shared projection knowing the
   * shape. For example, gateway-discord stores { discordMessageId, discordChannelId }.
   */
  sinkMetadata?: Record<string, unknown> | undefined
}

interface ProjectState {
  projectId: string
  runs: Map<string, RunState>
  focusedRunId?: string | undefined
}

const SESSION_METADATA_EVENT_TYPE_SET: ReadonlySet<string> = new Set(SESSION_METADATA_EVENT_TYPES)

function isSessionMetadataEvent(event: GatewaySessionEvent): boolean {
  return SESSION_METADATA_EVENT_TYPE_SET.has(event.type)
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: central dispatcher folding gateway session events into per-run projection state.
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

  const closeActiveSegment = (run: RunState): void => {
    run.activeAssistantSegmentId = undefined
  }

  const upsertAssistantSegment = (
    run: RunState,
    options: {
      id: string | undefined
      seq: number
      text: string
      mode: 'append' | 'replace' | 'set'
      close?: boolean
    }
  ): void => {
    const { id: rawId, seq: segSeq, text, mode, close = false } = options
    if (rawId !== undefined) {
      const idx = run.assistantSegments.findIndex((s) => s.id === rawId)
      if (idx >= 0) {
        const existing = run.assistantSegments[idx]
        if (existing) {
          run.assistantSegments[idx] = {
            ...existing,
            text: mode === 'append' ? existing.text + text : text,
          }
        }
        run.activeAssistantSegmentId = close ? undefined : rawId
        return
      }
    }

    if (mode === 'append' && run.activeAssistantSegmentId !== undefined && rawId === undefined) {
      const idx = run.assistantSegments.findIndex((s) => s.id === run.activeAssistantSegmentId)
      const existing = idx >= 0 ? run.assistantSegments[idx] : undefined
      if (existing) {
        run.assistantSegments[idx] = { ...existing, text: existing.text + text }
        if (close) run.activeAssistantSegmentId = undefined
        return
      }
    }

    if (mode === 'replace' && rawId === undefined && run.activeAssistantSegmentId !== undefined) {
      const idx = run.assistantSegments.findIndex((s) => s.id === run.activeAssistantSegmentId)
      const existing = idx >= 0 ? run.assistantSegments[idx] : undefined
      if (existing) {
        run.assistantSegments[idx] = { ...existing, text }
        if (close) run.activeAssistantSegmentId = undefined
        return
      }
    }

    const newId = rawId ?? `seg-${segSeq}`
    run.assistantSegments.push({ id: newId, seq: segSeq, text })
    run.activeAssistantSegmentId = close ? undefined : newId
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
        upsertAssistantSegment(run, {
          id: undefined,
          seq,
          text: event.finalOutput,
          mode: 'set',
          close: true,
        })
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
      if (!runId) {
        break
      }

      const run = getOrCreateRun(runId)
      run.lastSeq = seq
      const message = event.message
      const messageId = event.messageId
      if (message) {
        const content = flattenMessageContent(message.content)

        if (message.role === 'user') {
          run.userMessage = content
        } else if (message.role === 'assistant') {
          closeActiveSegment(run)
          const ref = messageId ?? `seg-${seq}`
          run.currentAssistantMessageRef = ref
          upsertAssistantSegment(run, {
            id: ref,
            seq,
            text: content,
            mode: 'set',
          })
        }
      } else if (messageId !== undefined) {
        closeActiveSegment(run)
        run.currentAssistantMessageRef = messageId
        upsertAssistantSegment(run, {
          id: messageId,
          seq,
          text: '',
          mode: 'set',
        })
      }

      newState.runs.set(runId, run)
      break
    }

    case 'message_end': {
      if (!runId) {
        break
      }

      const run = getOrCreateRun(runId)
      run.lastSeq = seq
      const message = event.message
      const messageId = event.messageId
      const targetRef = messageId ?? run.currentAssistantMessageRef
      if (message) {
        const content = flattenMessageContent(message.content)

        if (message.role === 'user') {
          run.userMessage = content
        } else if (message.role === 'assistant') {
          if (targetRef === undefined && run.assistantSegments.length > 0) {
            closeActiveSegment(run)
          } else {
            upsertAssistantSegment(run, {
              id: targetRef,
              seq,
              text: content,
              mode: 'replace',
              close: true,
            })
          }
        }
      } else if (targetRef !== undefined) {
        const idx = run.assistantSegments.findIndex((s) => s.id === targetRef)
        if (idx >= 0) {
          run.activeAssistantSegmentId = undefined
        }
      }
      if (targetRef !== undefined && targetRef === run.currentAssistantMessageRef) {
        run.currentAssistantMessageRef = undefined
      }

      newState.runs.set(runId, run)
      break
    }

    case 'message_update': {
      if (!runId) {
        break
      }

      const run = getOrCreateRun(runId)
      run.lastSeq = seq
      const targetRef = event.messageId ?? run.currentAssistantMessageRef

      if (event.textDelta) {
        upsertAssistantSegment(run, {
          id: targetRef,
          seq,
          text: event.textDelta,
          mode: 'append',
        })
        if (targetRef === undefined && run.activeAssistantSegmentId !== undefined) {
          run.currentAssistantMessageRef = run.activeAssistantSegmentId
        }
      }

      if (event.contentBlocks) {
        const textContent = event.contentBlocks
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text)
          .join('')

        if (textContent) {
          upsertAssistantSegment(run, {
            id: targetRef,
            seq,
            text: textContent,
            mode: 'replace',
          })
          if (targetRef === undefined && run.activeAssistantSegmentId !== undefined) {
            run.currentAssistantMessageRef = run.activeAssistantSegmentId
          }
        }
      }

      newState.runs.set(runId, run)
      break
    }

    case 'turn_end': {
      if (!runId) {
        break
      }

      const run = getOrCreateRun(runId)
      run.lastSeq = seq
      run.status = 'completed'
      run.completedAt = Date.now()
      const completedMessage = extractTurnEndAssistantMessage(event.payload)
      if (completedMessage !== undefined && run.assistantSegments.length === 0) {
        upsertAssistantSegment(run, {
          id: undefined,
          seq,
          text: completedMessage,
          mode: 'set',
          close: true,
        })
      } else {
        closeActiveSegment(run)
      }
      run.currentAssistantMessageRef = undefined
      newState.runs.set(runId, run)
      break
    }

    case 'tool_execution_start': {
      if (!runId) {
        break
      }

      const run = getOrCreateRun(runId)
      run.lastSeq = seq
      closeActiveSegment(run)
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

      newState.runs.set(runId, run)
      break
    }

    case 'tool_execution_end': {
      if (!runId) {
        break
      }

      const run = getOrCreateRun(runId)
      run.lastSeq = seq
      const toolIndex = run.toolExecutions.findIndex((tool) => tool.toolUseId === event.toolUseId)
      let output = ''
      const images: Array<{ data: string; mimeType: string }> = []
      const mediaRefs: Array<{
        url: string
        mimeType?: string | undefined
        filename?: string | undefined
        alt?: string | undefined
      }> = []

      const result = event.result as {
        content?: Array<{
          type: string
          text?: string | undefined
          data?: string | undefined
          mimeType?: string | undefined
          url?: string | undefined
          filename?: string | undefined
          alt?: string | undefined
        }>
        details?:
          | {
              content?: Array<{
                type: string
                text?: string | undefined
                data?: string | undefined
                mimeType?: string | undefined
                url?: string | undefined
                filename?: string | undefined
                alt?: string | undefined
              }>
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

      const existingOutput = toolIndex >= 0 ? run.toolExecutions[toolIndex]?.output : undefined
      const existingImages = toolIndex >= 0 ? run.toolExecutions[toolIndex]?.images : undefined
      const existingMediaRefs =
        toolIndex >= 0 ? run.toolExecutions[toolIndex]?.mediaRefs : undefined

      const finalOutput = output || existingOutput || ''
      const finalImages = images.length > 0 ? images : existingImages
      const finalMediaRefs = mediaRefs.length > 0 ? mediaRefs : existingMediaRefs

      if (toolIndex >= 0) {
        const existingTool = run.toolExecutions[toolIndex]
        if (!existingTool) {
          break
        }

        run.toolExecutions[toolIndex] = {
          ...existingTool,
          status: event.isError ? 'failed' : 'completed',
          output: finalOutput,
          images: finalImages,
          mediaRefs: finalMediaRefs,
        }
      } else {
        run.toolExecutions.push({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: {},
          seq,
          status: event.isError ? 'failed' : 'completed',
          output: finalOutput,
          images: finalImages,
          mediaRefs: finalMediaRefs,
        })
      }

      newState.runs.set(runId, run)
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
      if (!runId) {
        break
      }

      const run = getOrCreateRun(runId)
      run.lastSeq = seq
      run.noticeEntries.push({
        id: String(seq),
        level: event.level,
        message: event.message,
        seq,
      })
      newState.runs.set(runId, run)
      break
    }

    default:
      if (isSessionMetadataEvent(event)) {
        break
      }
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
  const truncated = oneLine.length > 100 ? `${oneLine.slice(0, 100)}...` : oneLine
  return `${emoji} ${truncated}`
}

function formatToolSummary(_toolName: string, toolInput: Record<string, unknown>): string {
  const truncate = (value: string, max: number) =>
    value.length > max ? `${value.slice(0, max)}...` : value

  for (const value of Object.values(toolInput)) {
    if (typeof value === 'string' && value.length > 0) {
      return `\`${truncate(value, 80)}\``
    }
  }

  const json = JSON.stringify(toolInput)
  return json.length > 2 ? truncate(json, 80) : ''
}

type TimelineEntry = { seq: number; block: RenderFrame['blocks'][number] }

function toolBlocks(run: RunState): TimelineEntry[] {
  return run.toolExecutions.map((tool) => ({
    seq: tool.seq,
    block: {
      t: 'tool',
      toolName: tool.toolName,
      summary: formatToolSummary(tool.toolName, tool.input),
      input: tool.input,
      output: tool.output,
      images: tool.images,
      approved: tool.status === 'completed' ? true : tool.status === 'failed' ? false : undefined,
    },
  }))
}

function collectMediaRefs(run: RunState): Array<{
  url: string
  mimeType?: string | undefined
  filename?: string | undefined
  alt?: string | undefined
}> {
  const allMediaRefs: Array<{
    url: string
    mimeType?: string | undefined
    filename?: string | undefined
    alt?: string | undefined
  }> = []
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
      md: formatToolSummary(runningTool.toolName, runningTool.input),
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

export function runStateToFrame(run: RunState): RenderFrame {
  const phase = STATUS_TO_PHASE[run.status]

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

  const actions = run.permissionRequest?.actions.map((action) => ({
    id: action.id,
    kind: action.kind,
    label: action.label,
    style: action.style,
  }))

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
  private readonly onRunQueued?: OnRunQueuedCallback | undefined
  private readonly sessions = new Map<string, ProjectState>()

  constructor(gatewayId: string, onRender: OnRenderCallback, onRunQueued?: OnRunQueuedCallback) {
    this.gatewayId = gatewayId
    this.onRender = onRender
    this.onRunQueued = onRunQueued
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

  /**
   * Set opaque sink-specific metadata on a run state. Sinks use this to stash
   * their own tracking info (e.g. Discord message/channel IDs, terminal pane refs).
   */
  setSinkMetadata(sessionRef: string, runId: string, metadata: Record<string, unknown>): void {
    const project = this.sessions.get(sessionRef)
    const run = project?.runs.get(runId)
    if (!run) {
      return
    }

    run.sinkMetadata = { ...(run.sinkMetadata ?? {}), ...metadata }
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

    if (event.type === 'run_queued' && this.onRunQueued) {
      this.onRunQueued(event.projectId, event.runId, event.input.content)
    }

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
