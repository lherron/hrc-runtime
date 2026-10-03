export type SessionEffectiveStatus = 'active' | 'detached' | 'inactive' | 'stale'
export type SessionExecutionMode = 'headless' | 'interactive' | 'nonInteractive'

export type SessionTitleSource = 'generated' | 'manual'

export type SessionTitleRecord = {
  hostSessionId: string
  title: string
  source: SessionTitleSource
  model?: string | undefined
  createdAt: string
  updatedAt: string
}

export type SetSessionTitleRequest = {
  title: string
  source: SessionTitleSource
  model?: string | undefined
  /** Required to replace an existing manual title. */
  force?: boolean | undefined
}

export type DeleteSessionTitleResponse = {
  hostSessionId: string
  deleted: boolean
}

export type SessionPageFilters = {
  q?: string | undefined
  agentId?: string | undefined
  projectId?: string | undefined
  laneRef?: string | undefined
  effectiveStatus?: SessionEffectiveStatus | undefined
  executionMode?: SessionExecutionMode | undefined
  /** `all`, `local`, or a comma-separated exact nodeId set. */
  nodes?: string | undefined
}

export type SessionPageRequest = SessionPageFilters & {
  limit?: number | undefined
  /** Opaque; callers must preserve it byte-for-byte and restart after filter changes. */
  cursor?: string | undefined
}

export type SessionFacetsRequest = SessionPageFilters

export type SessionPageItem = {
  nodeId: string
  hostSessionId: string
  title?: string | undefined
  scopeRef: string
  laneRef: string
  generation: number
  agentId: string
  projectId?: string | undefined
  createdAt: string
  effectiveStatus: SessionEffectiveStatus
  executionMode: SessionExecutionMode
  lastActivityAt: string
}

export type SessionPeerStatus = {
  state: 'healthy' | 'invalid-response' | 'refused' | 'unreachable'
  checkedAt: string
  detail?: string | undefined
}

export type SessionPageResponse = {
  items: SessionPageItem[]
  nextCursor?: string | undefined
  /** Per-node lifecycle-event high-water, captured before that node's page rows. */
  eventHighWater: Record<string, number>
  complete: boolean
  peerStatus: Record<string, SessionPeerStatus>
}

export type SessionFacetsResponse = {
  total: number
  byEffectiveStatus: Record<string, number>
  byExecutionMode: Record<string, number>
  byAgentId: Record<string, number>
  byNodeId: Record<string, number>
  complete: boolean
  peerStatus: Record<string, SessionPeerStatus>
}
