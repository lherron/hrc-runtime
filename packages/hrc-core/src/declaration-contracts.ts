/**
 * T-08564 Phase A: HTTP contracts for declaration-backed runtime intent
 * resolution and plan preview. HRC is the only caller of the node-local aspd;
 * the CLI and SDK reach ASP declaration interpretation through these routes.
 */
import type { ProvisioningScalars } from 'agent-scope'

import type { HrcExecutionMode, HrcRuntimeIntent } from './contracts.js'
import type { RestartStyle } from './http-contracts.js'
import type { WrkqProjectRegistryEntry } from './project-registry.js'

export type DeclarationRunMode = 'query' | 'heartbeat' | 'task' | 'maintenance'

export type DeclarationSourceState = 'absent' | 'valid' | 'invalid'

type ResolveRuntimeIntentOptions = {
  runMode?: DeclarationRunMode | undefined
  interactive?: boolean | undefined
  preferredMode?: HrcExecutionMode | undefined
  allowInteractiveSurfaceReuse?: boolean | undefined
  initialPrompt?: string | undefined
}

/** Resolve a declaration for paths that the caller has already selected. */
export type ResolveRuntimeIntentByPathsRequest = ResolveRuntimeIntentOptions & {
  agentId: string
  /** Required: the caller's already-resolved agent root is read exactly. */
  agentRoot: string
  projectId?: string | undefined
  /** Present → project mode `root`; omitted → project mode `none` (projectless). */
  projectRoot?: string | undefined
  cwd: string
  provision?: Partial<ProvisioningScalars> | undefined
  agentSources?: { agentsRoot?: string | undefined; aspHome?: string | undefined } | undefined
}

/**
 * Resolve a declaration for a scope using the daemon's placement policy.
 *
 * A socket injector knows its target scope, not the daemon's local checkout
 * paths.  This arm deliberately has no caller-supplied root or agent sources:
 * HRC resolves those before it observes the declaration through aspd.
 */
export type ResolveRuntimeIntentByScopeRequest = ResolveRuntimeIntentOptions & {
  scopeRef: string
  materializationIntent?: string | undefined
}

export type ResolveRuntimeIntentRequest =
  | ResolveRuntimeIntentByPathsRequest
  | ResolveRuntimeIntentByScopeRequest

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
  specHash: string
  startRequestHash: string
  /** Producer-resolved selection, including the precedence source for every field. */
  selection: {
    harness: string
    modelProvider: string
    model: string
    reasoningEffort?: string | undefined
    presentation: boolean
    provenance: {
      harness: string
      modelProvider: string
      model: string
      reasoningEffort?: string | undefined
      presentation: string
    }
  }
  /** The one frozen execution HRC will host; never a reconstructed profile. */
  execution: {
    recipeId: string
    driver: string
    protocol: string
    hosting: {
      executionTransport: string
      terminalRequired: boolean
      terminalHost?: string | undefined
      processExecution: string
    }
    presentationFulfillment: 'intrinsic' | 'attachable' | 'birth-variant'
    presentationSurface?:
      | { transport: 'terminal' | 'websocket-unix'; terminalHost: 'tmux' }
      | undefined
    profile: {
      profileId: string
      profileHash: string
      compatibilityHash: string
      startRequestHash: string
    }
  }
  process:
    | {
        command: string
        args: string[]
        cwd: string
        execution?: never
      }
    | {
        execution: 'native-worker'
        cwd: string
        command?: never
        args?: never
      }
  initialInput: boolean
  launchInitialPromptLength?: number | undefined
  inputQueue: string
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
  /** ASP daemon release that compiled this preview, when the daemon supplied it. */
  release?: { releaseId: string; sourceCommit: string } | undefined
}

export type RunDiagnostics = {
  releases: {
    hrc?: { releaseId?: string | undefined; sourceCommit?: string | undefined } | undefined
    aspd?: { releaseId: string; sourceCommit: string } | undefined
    execution?: { releaseId: string; sourceCommit: string } | undefined
  }
  ids: Record<string, string>
  selection?: BrokerRunPreview['selection'] | undefined
  /** ASP-owned frozen execution metadata, when the diagnostic route supplies it. */
  execution?: BrokerRunPreview['execution'] | undefined
  phases: import('./run-diagnostics.js').PhaseRecord[]
}

export type RunPreviewResponse = BrokerRunPreview & {
  promptResolution?: Record<string, unknown> | undefined
  diagnostics: RunDiagnostics
}

export type ResolvePlacementRequest = {
  /** Canonical scope ref (`agent:<id>[:project:<p>][:task:<t>][:role:<r>][/lane:<l>]`). */
  scopeRef?: string | undefined
  /** Alternative to scopeRef: agent id. */
  agentId?: string | undefined
  /** Alternative to scopeRef: project id (explicit project). */
  projectId?: string | undefined
  /** Alternative to scopeRef: task id (worktree refinement + declaration context). */
  taskId?: string | undefined
  /** Discovery seed for marker inference + sibling fallback. Required. */
  cwd?: string | undefined
  /** Explicit project-root override (wins over every discovery step). */
  projectRoot?: string | undefined
  /** Explicit agent-root override (read exactly, `caller-agent-root`). */
  agentRoot?: string | undefined
  runMode?: DeclarationRunMode | undefined
  /**
   * Strict for launch placement; advisory for messaging/read selectors.
   * Advisory downgrades a worktree-refinement failure to a warning.
   */
  taskWorktreeAssociation?: 'strict' | 'advisory' | undefined
  /**
   * Whether the project came from the scope itself or caller-side inference.
   * An 'inferred' project with a projectId keeps the cwd walk-up (it does not
   * promote to the explicit registry/marker/sibling chain).
   */
  projectOrigin?: 'explicit' | 'inferred' | undefined
  /** Test seam; production omits it so the daemon reads its own registry. */
  registryProjects?: WrkqProjectRegistryEntry[] | undefined
  /** Test seam; production omits it so the daemon uses its own search roots. */
  projectSearchRoots?: string[] | undefined
}

/**
 * Runtime transport family for a harness (`cli` = spawned CLI driver,
 * `sdk` = in-process SDK driver). Vendored shape of spaces-config
 * HarnessTransport — the VALUE is ASP interpretation and arrives via aspd
 * observation only (T-08600 projects it; until then the field is absent).
 */
export type HarnessTransport = 'cli' | 'sdk'

export type ResolvePlacementResponse = {
  agentId: string
  projectId?: string | undefined
  taskId?: string | undefined
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  cwd?: string | undefined
  bundle?: HrcRuntimeIntent['placement']['bundle'] | undefined
  bundleIdentity?: string | undefined
  harness: {
    provider: 'anthropic' | 'openai'
    frontend: string
    effectiveHarness: string
    /**
     * NAMED GAP (T-08597 route requirement, ASP T-08600): absent until aspd's
     * provisioning observation projects `transport`. HRC does not derive this
     * from the frontend — the frontend→transport table is the ASP catalog.
     */
    transport?: HarnessTransport | undefined
    /**
     * NAMED GAP (same): derived as `transport !== 'sdk'` (the exact rule in
     * ACP real-launcher.ts). Absent while transport is absent — never echoed
     * from caller turn semantics.
     */
    interactive?: boolean | undefined
  }
  provision: {
    scalars: Record<string, string | number | boolean>
    declaredHarness?: string | undefined
  }
  policy: {
    claimsTask: boolean
    provisioningNode?: string | undefined
    placement: { pins: Record<string, string>; homes: Record<string, string> }
  }
  identity: {
    role?: string | undefined
    operator: boolean
  }
  agentSources: ResolvedDeclarationAgentSources
  searchedAgentRoots: string[]
  markerProjectId?: string | undefined
  source: {
    agentProfile: DeclarationSourceState
    projectTargets: DeclarationSourceState
    selectedTarget: DeclarationSourceState
    priming: DeclarationSourceState
  }
  resolution: {
    source:
      | 'explicit-override'
      | 'wrkq-registry'
      | 'marker-scan'
      | 'sibling-fallback'
      | 'task-worktree'
      | 'inferred'
      | 'projectless'
    projectId?: string | undefined
    canonicalRoot?: string | undefined
    cwd?: string | undefined
    branch?: string | undefined
    reason: string
  }
  warnings: string[]
  release: { releaseId: string; sourceCommit: string }
}
