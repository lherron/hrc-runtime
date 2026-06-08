export type RunId = string
export type ProjectId = string

export interface PermissionAction {
  id: string
  kind: 'approve' | 'deny' | 'always_allow'
  label: string
  style?: 'primary' | 'danger' | undefined
}

export interface RenderFrame {
  runId: RunId
  projectId: ProjectId
  phase: 'queued' | 'progress' | 'permission' | 'final' | 'error'
  title?: string | undefined
  blocks: RenderBlock[]
  actions?: RenderAction[] | undefined
  statusLine?: string | undefined
  updatedAt: number
  persona?:
    | {
        id: string
        displayName: string
        avatarUrl?: string | undefined
      }
    | undefined
}

export type RenderBlock =
  | { t: 'markdown'; md: string }
  | { t: 'code'; lang?: string | undefined; code: string }
  | { t: 'image'; data: string; mimeType: string; alt?: string | undefined }
  | {
      t: 'media_ref'
      url: string
      mimeType?: string | undefined
      filename?: string | undefined
      alt?: string | undefined
    }
  | { t: 'kv'; items: Array<{ k: string; v: string }> }
  | {
      t: 'progress_list'
      items: Array<{ id: string; text: string; state: 'running' | 'done' | 'fail' }>
    }
  | {
      t: 'tool'
      toolName: string
      summary: string
      input?: Record<string, unknown> | undefined
      output?: string | undefined
      images?: Array<{ data: string; mimeType: string }> | undefined
      approved?: boolean | undefined
      approvalSource?: string | undefined
    }
  | { t: 'notice'; level: 'info' | 'warn' | 'error'; message: string }

export type RenderAction = {
  id: string
  kind: 'approve' | 'deny' | 'always_allow'
  label: string
  style?: 'primary' | 'danger' | undefined
}

export type GatewayRunQueuedEvent = {
  type: 'run_queued'
  runId: string
  projectId: string
  queuedAt: number
  input: {
    content: string
    attachments?:
      | Array<{
          kind: 'url' | 'file'
          filename?: string | undefined
        }>
      | undefined
  }
  queuePosition?: number | undefined
}

export type GatewayRunStartedEvent = {
  type: 'run_started'
  runId: string
  projectId: string
  startedAt: number
}

export type GatewayRunCompletedEvent = {
  type: 'run_completed'
  runId: string
  projectId: string
  completedAt: number
  finalOutput?: string | undefined
}

export type GatewayRunFailedEvent = {
  type: 'run_failed'
  runId: string
  projectId: string
  failedAt: number
  error: {
    code: string
    message: string
  }
}

export type GatewayRunCancelledEvent = {
  type: 'run_cancelled'
  runId: string
  projectId: string
  cancelledAt: number
  reason?: string | undefined
}

export type GatewayPermissionRequestEvent = {
  type: 'permission_request'
  requestId: string
  runId: string
  projectId: string
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
  actions: PermissionAction[]
  requestedAt: number
}

export type GatewayPermissionDecisionEvent = {
  type: 'permission_decision'
  requestId: string
  runId: string
  projectId: string
  toolUseId: string
  decision: 'allow' | 'deny' | 'always_allow'
  source: string
  decidedAt: number
}

/**
 * Single source of truth for session-metadata event type names. Both the
 * runtime classification list and the {@link GatewaySessionMetadataEvent}
 * union are derived from this tuple, so they cannot silently drift.
 */
export const SESSION_METADATA_EVENT_TYPES = [
  'continuation_key_observed',
  'user_input_received',
  'user_input_queued_in_flight',
  'user_input_applied_in_flight',
  'user_input_interrupt_requested',
  'user_input_interrupt_applied',
  'user_input_rejected',
  'harness_process_started',
  'harness_process_exited',
  'tmux_pane_bound',
  'tmux_pane_unbound',
  'ghostty_surface_bound',
  'ghostty_surface_unbound',
  'sdk_session_id',
] as const

export type GatewaySessionMetadataEvent = {
  type: (typeof SESSION_METADATA_EVENT_TYPES)[number]
}

export type GatewayNoticeEvent = {
  type: 'notice'
  level: 'info' | 'warn' | 'error'
  message: string
}

export type GatewaySessionEvent =
  | import('spaces-runtime').UnifiedSessionEvent
  | GatewayRunQueuedEvent
  | GatewayRunStartedEvent
  | GatewayRunCompletedEvent
  | GatewayRunFailedEvent
  | GatewayRunCancelledEvent
  | GatewayPermissionRequestEvent
  | GatewayPermissionDecisionEvent
  | GatewaySessionMetadataEvent
  | GatewayNoticeEvent

export type SessionEventEnvelope = {
  sessionRef: string
  projectId: string
  runId?: string | undefined
  seq?: number | undefined
  run?:
    | {
        visibility?: 'user' | 'internal' | undefined
      }
    | undefined
  event: GatewaySessionEvent
}
