import type { MediaRef, RunState } from './session-events-types.js'
import type { RenderFrame } from './types.js'

const TITLE_MAX_LEN = 100
const TOOL_SUMMARY_MAX_LEN = 80
const EMPTY_JSON_LEN = 2

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
