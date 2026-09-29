import type { PermissionAction } from './types.js'

export type MediaRef = {
  url: string
  mimeType?: string | undefined
  filename?: string | undefined
  alt?: string | undefined
}

export type ToolResultContentBlock = {
  type: string
  text?: string | undefined
  data?: string | undefined
  mimeType?: string | undefined
  url?: string | undefined
  filename?: string | undefined
  alt?: string | undefined
}

export interface ToolExecution {
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

export interface ProjectState {
  projectId: string
  runs: Map<string, RunState>
  focusedRunId?: string | undefined
}
