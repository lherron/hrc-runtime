import type { Release } from './aspd-route-doubles'

export type ResolveScript =
  | 'ok'
  | 'absent'
  | 'invalid'
  | 'incompatible'
  | 'agent-profile-invalid-live'
export type PromptScript = 'present' | 'absent' | 'invalid'

export type AspdObservationOptions = {
  /**
   * Fixture agent home: when the declaration context carries no caller
   * agentRoot, resolve the agent here instead of the canned default. Lets
   * kicker/summon tests birth fixture agents (homes invisible to a real
   * aspd) while keeping every other fact canned per script.
   */
  agentRoot?: string
  /**
   * Fixture agents roots searched in order (real homes appended
   * automatically): a profile hit resolves with the REAL agent home, a total
   * miss answers agent_not_found. Lets negative tests (unknown agents) keep
   * failing while fixture agents birth.
   */
  agentsRoots?: string[]
  resolve?: ResolveScript
  prompt?: PromptScript
  inspectNonOk?: boolean
  compileRejected?: boolean
  identityRole?: string
  invalidAgentProfile?: boolean
  invalidAgentProfileNoTarget?: boolean
  absentAgentProfile?: boolean
  nonexistentAgentRoot?: boolean
  protocolVersion?: string
  capabilities?: Partial<{
    resolveRuntimeDeclaration: boolean
    inspectRuntimePlacement: boolean
    compileHarnessInvocation: boolean
    inspectRuntimePlacementPreparationCorrelation: boolean
  }>
  socketAbsent?: boolean
}

export type ObservationRequest = {
  method: string
  params: Record<string, unknown>
}

export type ObservationConnection = {
  methods: string[]
  requests: ObservationRequest[]
}

export type AspdObservationDouble = {
  serving: Release
  connections: ObservationConnection[]
  openConnections: number
  stop(): void
}
