import type { ProvisioningScalars } from 'agent-scope'

import type { HrcExecutionMode, HrcHarness, HrcProvider } from './contracts-events.js'
import type {
  HrcAttachmentRef as AttachmentRef,
  HrcRuntimePlacement as RuntimePlacement,
} from './placement-conventions.js'

export type HrcHarnessIntent = {
  /**
   * Legacy routing metadata. Omitted ordinary v2 births leave provider
   * selection to ASP rather than projecting its realized value back into an
   * HRC request.
   */
  provider?: HrcProvider | undefined
  interactive: boolean
  id?: HrcHarness | undefined
  fallback?: string | undefined
  model?: string | undefined
  yolo?: boolean | undefined
}

export type HrcApprovedMutationRef = {
  schemaVersion: 'hrc.approved-mutation-ref/v1'
  source: 'wrkf-action' | 'manual-operator'
  /**
   * A local file URI for an approval evidence record, pinned with a
   * `#sha256:<hex>` fragment. HRC resolves and verifies it before launch.
   */
  approvalRef: string
  /** A local file URI for the immutable apply artifact. */
  artifactRef: string
  artifactKind: 'unified-diff' | 'git-apply-patch' | 'file-set'
  targetPaths: string[]
  expectedBaseRevision?: string | undefined
  expectedBaseTreeHash?: string | undefined
  /** Required when artifactRef names mutable storage. */
  artifactContentHash?: string | undefined
  taskRef?: string | undefined
  taskSpecHash?: string | undefined
  taskEtag?: string | undefined
  workflowRunId?: string | undefined
  actionRunId?: string | undefined
  approvedBy?: string | undefined
  approvedAt?: string | undefined
}

export type HrcActuatorSplitPolicy = {
  schemaVersion: 'hrc.actuator-split-policy/v1'
  mode: 'off' | 'high-risk'
  workflowRef?: string | undefined
  laneClass: 'worker' | 'verifier' | 'reviewer' | 'approver' | 'actuator'
  codeMutation: 'forbidden' | 'staged-output-only' | 'apply-approved-artifact'
  productionCodePaths?: string[] | undefined
  approval?: HrcApprovedMutationRef | undefined
}

export type HrcActuatorSplitAuthorityView = {
  actuatorSplit: Omit<HrcActuatorSplitPolicy, 'approval'>
  approvedMutation?:
    | {
        approvalRecordHash: string
        artifactContentHash: string
        targetPaths: string[]
        expectedBaseRevision?: string | undefined
        expectedBaseTreeHash?: string | undefined
        approvedBy?: string | undefined
        approvedAt?: string | undefined
      }
    | undefined
}

export type HrcExecutionIntent = {
  preferredMode?: HrcExecutionMode | undefined
  autoLaunchInteractive?: boolean | undefined
  allowFallback?: boolean | undefined
  /**
   * T-05177 / T-07397: when explicitly `false`, this dispatch is never delivered
   * into a live interactive surface that the DISPATCHING CALLER did not itself
   * establish. HRC satisfies it in exactly one of three ways:
   *   - a fresh runtime, when the scope has no healthy matching live surface;
   *   - reuse of the caller's OWN broker invocation, proven by carrying
   *     `establishedBrokerInvocationId` (see DispatchTurnRequest) equal to that
   *     runtime's active invocation — this is what makes multi-turn sessions
   *     possible without weakening the guarantee;
   *   - otherwise a loud, ZERO-MUTATION failure
   *     (runtime-unavailable / 'caller-surface-reuse-refusal'). Refusing
   *     delivery into a surface is never authority to invalidate it: the live
   *     runtime's status, activeRunId and in-flight turn are left untouched.
   * "Autonomous one-shot" was the original framing (the codex "DM lands in the
   * operator's open TUI" reuse); the rule is about SURFACE OWNERSHIP, not turn
   * count. Undefined ⇒ treated as `true` (preserves DM-into-open-TUI for every
   * existing caller), EXCEPT that a carried `establishedBrokerInvocationId` is
   * always checked (T-08540): a caller that claims a surface must own it.
   */
  allowInteractiveSurfaceReuse?: boolean | undefined
  /**
   * Additive high-risk lane authority. Absent (or mode `off`) preserves the
   * ordinary low-risk route and reuse behavior.
   */
  actuatorSplit?: HrcActuatorSplitPolicy | undefined
}

export type HrcLaunchEnvConfig = {
  env?: Record<string, string> | undefined
  unsetEnv?: string[] | undefined
  pathPrepend?: string[] | undefined
}

export type HrcTaskContext = {
  taskId: string
  phase: string | null
  role: string
  requiredEvidenceKinds: string[]
  hintsText: string
}

/**
 * Operator presentation hints for a provisioned session (T-07118).
 *
 * Purely a placement preference for the observational viewer surface: it never
 * changes what is launched, only where the viewer tab lands. An absent
 * `presentation` — or an absent `viewerWindow` — means the implicit default
 * window key, i.e. today's "Headless Sessions" topology, byte for byte.
 */
export type HrcPresentationIntent = {
  /**
   * Free-form Ghostty window key. Panes are grouped into the window whose
   * anchor carries the matching `hrc_window_key` metadata; a missing keyed
   * window is created fresh (degraded, never broken).
   */
  viewerWindow?: string | undefined
  /**
   * T-08553 per-request operator presentation. `'none'` declines the node's
   * operator viewer for a NEW execution and selects headless execution: it
   * overrides the node's headless presentation default and exempts a Codex
   * dispatch from the node's Codex interactive redirect. Absent ⇒ both node
   * defaults apply unchanged. It cannot select a viewer, is refused off the
   * headless broker route or together with `viewerWindow`, and never changes a
   * live runtime (a conflicting live presentation refuses the request).
   *
   * T-08554: `'tmux-tui'` selects the headless codex-app-server WITH HRC's tmux-tui
   * renderer viewer for a new execution: the same redirect exemption as `'none'`,
   * the viewer regardless of the node default, and (with aspd configured) the
   * aspd-prepared route. Refused off the headless codex-app-server broker route.
   *
   * `'observer'` selects the headless muse-serve WITH HRC's observer-pane
   * renderer viewer for a new execution. Refused off the headless muse-serve
   * broker route.
   */
  operator?: 'none' | 'tmux-tui' | 'observer' | undefined
}

/**
 * Explicit v2 compile-request overrides. These fields are intentionally
 * optional: absence belongs to ASP's profile/target/default precedence, while
 * an explicit `false` presentation is a real override.
 */
export type HrcRequestedHarnessSelection = {
  harness?: 'agent-harness' | 'claude' | 'codex' | 'muse' | undefined
  modelProvider?: string | undefined
  model?: string | undefined
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
  presentation?: boolean | undefined
}

/**
 * Raw per-summon values. Snake case deliberately distinguishes this lower
 * precedence source from the explicit compile-request overrides above.
 */
export type HrcSummonHarnessDirectives = {
  harness?: 'agent-harness' | 'claude' | 'codex' | 'muse' | undefined
  model_provider?: string | undefined
  model?: string | undefined
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
  presentation?: boolean | undefined
}

export type HrcRuntimeIntent = {
  placement: RuntimePlacement
  harness: HrcHarnessIntent
  /** Producer-owned v2 selection request; HRC neither fills nor normalizes it. */
  selection?: HrcRequestedHarnessSelection | undefined
  /** Raw per-summon v2 directives; forwarded only at selectionContext.summonDirectives. */
  summonDirectives?: HrcSummonHarnessDirectives | undefined
  /**
   * T-07398 — the effective `[provisioning]` top-level scalars this runtime is
   * born with, after the profile+target merge and any per-summon directive
   * overlay. One type, three homes (toml base / directive override / this wire
   * form), so no surface needs a request-body field of its own: `provision`
   * rides the intent every existing door already carries.
   *
   * Birth-only. A directive block arriving at an ALREADY-LIVE scope is reported
   * back as `directivesApplied: false` and never rewrites the sticky birth
   * intent — the runtime's active values are the ones it was born with.
   *
   * Structurally top-level scalars only: nested harness tables
   * (`provisioning.claude`, `provisioning.codex`) are profile-only and are
   * refused here by shape, which closes the nested-spelling deny-list bypass
   * without enumerating spellings.
   */
  provision?: Partial<ProvisioningScalars> | undefined
  execution?: HrcExecutionIntent | undefined
  launch?: HrcLaunchEnvConfig | undefined
  initialPrompt?: string | undefined
  /**
   * Suppress profile priming so `initialPrompt` is the whole launch turn.
   * This is a one-shot compilation hint; callers must not persist it as
   * reusable session authority.
   */
  omitPriming?: boolean | undefined
  attachments?: AttachmentRef[] | undefined
  taskContext?: HrcTaskContext | undefined
  presentation?: HrcPresentationIntent | undefined
}
