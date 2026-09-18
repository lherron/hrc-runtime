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

/**
 * T-08596 (T-08569A closure) — the broker-run preview wire shape, moved here
 * from hrc-server so the SDK and CLI consume daemon previews without importing
 * server code. Pure data: the daemon compiles via aspd and projects the
 * admitted plan plus prompt zones into this shape.
 */
export type BrokerRunPreviewPromptZones = {
  systemPrompt: string
  systemPromptMode: 'append' | 'replace'
  reminderContent?: string | undefined
  promptSectionSizes: string[]
  reminderSectionSizes: string[]
  totalContextChars: number
  maxChars?: number | undefined
  nearMaxChars?: boolean | undefined
}

export type BrokerRunPreview = {
  controllerKind: 'harness-broker'
  brokerDriver: string
  interactionMode: string
  profileId: string
  profileHash: string
  specHash: string
  startRequestHash: string
  process: {
    command: string
    args: string[]
    cwd: string
  }
  initialInput: boolean
  launchInitialPromptLength?: number | undefined
  inputQueue: string
  interrupt: string
  resource?: string | undefined
  warnings: string[]
  systemPromptFile?: string | undefined
  systemPromptMode?: 'append' | 'replace' | undefined
  primingPrompt?: string | undefined
  systemPrompt?: string | undefined
  reminderContent?: string | undefined
  promptSectionSizes?: string[] | undefined
  reminderSectionSizes?: string[] | undefined
  totalContextChars?: number | undefined
  maxChars?: number | undefined
  nearMaxChars?: boolean | undefined
  env: Record<string, string>
  planHash: string
  compileId: string
  bundleIdentity: string
  model: {
    provider: string
    modelId: string
    requestedModel?: string | undefined
  }
}

export type RunPreviewResponse =
  | (BrokerRunPreview & {
      promptResolution?: Record<string, unknown> | undefined
      release?: { releaseId: string; sourceCommit: string } | undefined
    })
  | null
