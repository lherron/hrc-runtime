/**
 * T-08564 Phase A: HTTP contracts for declaration-backed runtime intent
 * resolution and plan preview. HRC is the only caller of the node-local aspd;
 * the CLI and SDK reach ASP declaration interpretation through these routes.
 */
import type { ProvisioningScalars } from 'agent-scope'

import type { HrcExecutionMode, HrcRuntimeIntent } from './contracts.js'
import type { RestartStyle } from './http-contracts.js'

export type DeclarationRunMode = 'query' | 'heartbeat' | 'task' | 'maintenance'

export type DeclarationSourceState = 'absent' | 'valid' | 'invalid'

export type ResolveRuntimeIntentRequest = {
  agentId: string
  /** Required: the caller's already-resolved agent root is read exactly. */
  agentRoot: string
  projectId?: string | undefined
  /** Present → project mode `root`; omitted → project mode `none` (projectless). */
  projectRoot?: string | undefined
  cwd: string
  runMode?: DeclarationRunMode | undefined
  interactive?: boolean | undefined
  preferredMode?: HrcExecutionMode | undefined
  allowInteractiveSurfaceReuse?: boolean | undefined
  initialPrompt?: string | undefined
  provision?: Partial<ProvisioningScalars> | undefined
  agentSources?: { agentsRoot?: string | undefined; aspHome?: string | undefined } | undefined
}

export type ResolvedDeclarationAgentSources = {
  aspHome?: string | undefined
  agentsRoot?: string | undefined
  provenance:
    | 'caller-agent-root'
    | 'caller'
    | 'caller-asp-home-config'
    | 'project-marker'
    | 'daemon-default'
}

export type ResolveRuntimeIntentResponse = {
  intent: HrcRuntimeIntent
  declaration: {
    release: { releaseId: string; sourceCommit: string }
    agentSources: ResolvedDeclarationAgentSources
    source: {
      agentProfile: DeclarationSourceState
      projectTargets: DeclarationSourceState
      selectedTarget: DeclarationSourceState
      priming: DeclarationSourceState
    }
    /** HRC-owned single-line warnings (e.g. `agent.provisioning.stripped`); never logged by the route. */
    warnings: string[]
  }
}

export type RunPreviewRequest = {
  intent: HrcRuntimeIntent
  sessionRef: string
  restartStyle?: RestartStyle | 'fresh' | 'reuse' | undefined
  promptLength?: number | undefined
}
