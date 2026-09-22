/**
 * Shared fixtures for the W2 broker compile-adapter + profile-selector red tests
 * (T-01695 / T-01690 Harness Broker cutover, headless codex-app-server only).
 *
 * These are synthetic compiled plans built with the exported
 * spaces-runtime-contracts neutral hash helpers. No live compiler/broker is required.
 *
 * NOTE: this file is intentionally NOT a `*.test.ts` so the bun runner does not
 * execute it directly; it is imported by the red test files. It also is NOT named
 * `compile-*.ts` and does not live under `src/agent-spaces-adapter/`, so it is
 * outside the W1A broker-path boundary guard.
 */

import type { HarnessInvocationSpec, InvocationStartRequest } from 'spaces-harness-broker-protocol'
import {
  neutralSpecHash as sharedNeutralSpecHash,
  neutralStartRequestHash as sharedNeutralStartRequestHash,
} from 'spaces-runtime-contracts'
import type { RuntimeCompileRequest, RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import type { SelectedExecution, SelectedExecutionPlan } from '../broker/selected-execution'

/**
 * Historical v1 fixture data retained solely by legacy controller tests. It is
 * not an ASP contract type and must never cross the v2 compile adapter.
 */
export type LegacyBrokerExecutionProfile = {
  schemaVersion: 'agent-runtime-profile/v1'
  profileId: string
  profileHash: string
  compatibilityHash: string
  kind: 'harness-broker'
  interactionMode: 'headless' | 'interactive' | 'nonInteractive'
  brokerProtocol: 'harness-broker/0.2'
  brokerDriver: string
  brokerOwnership: 'hrc-owned-process'
  brokerTerminal?: { host: string } | undefined
  expectedCapabilities: Record<string, unknown>
  harnessInvocation: {
    startRequest: InvocationStartRequest
    specHash: string
    startRequestHash: string
  }
  policy: {
    permissionPolicy: { mode: 'deny'; audit: boolean }
    inputPolicy: Record<string, unknown>
    exposurePolicy: Record<string, unknown>
  }
  observability: Record<string, unknown>
  diagnostics?: unknown[] | undefined
}

export type LegacyRuntimeCompileResponse =
  | {
      schemaVersion: 'agent-runtime-compile-response/v1'
      ok: true
      plan: {
        schemaVersion: 'agent-runtime-plan/v1'
        compiler: { name: string; version: string }
        compileId: string
        planHash: string
        createdAt: string
        identity: RuntimeIdentityAllocation
        placement: {
          agentRoot: string
          runMode: string
          bundle: { kind: string; compose: string[] }
        }
        resolvedBundle: { bundleIdentity: string }
        harness: { family: string; runtime: string; provider: string }
        model: { provider: string; modelId: string }
        executionProfiles: LegacyBrokerExecutionProfile[]
        artifacts: { bundleIdentity: string }
        lockedEnv: { lockedEnvKeys: string[] }
        diagnostics: unknown[]
      }
      diagnostics: unknown[]
    }
  | {
      schemaVersion: 'agent-runtime-compile-response/v1'
      ok: false
      diagnostics: Array<{ level: 'error'; code: string; message: string; plane: 'asp-compiler' }>
    }

export function neutralSpecHash(spec: HarnessInvocationSpec): string {
  return sharedNeutralSpecHash(spec)
}

export function neutralStartRequestHash(startRequest: InvocationStartRequest): string {
  return sharedNeutralStartRequestHash(startRequest)
}

/**
 * The v2 controller seam accepts one producer-selected execution, not a
 * profile selected by HRC. The legacy helper below remains only to construct
 * the canonical broker startRequest whose neutral hash this fixture proves.
 */
export type SelectedExecutionFixtureOpts = FixtureOpts & {
  presentationSurface?: SelectedExecution['presentationSurface']
  presentationFulfillment?: SelectedExecution['presentationFulfillment']
}

export function makeSelectedExecution(
  identity: RuntimeIdentityAllocation,
  opts: SelectedExecutionFixtureOpts = {}
): { execution: SelectedExecution; startRequest: InvocationStartRequest } {
  const { profile, startRequest } = makeBrokerProfile(identity, opts)
  const interactive = profile.interactionMode === 'interactive'
  return {
    execution: {
      recipeId: `fixture-${profile.brokerDriver}`,
      driver: profile.brokerDriver,
      protocol: 'harness-broker/0.2',
      hosting: interactive
        ? {
            executionTransport: 'pty',
            terminalRequired: true,
            terminalHost: 'tmux',
            processExecution: 'broker-process',
          }
        : {
            executionTransport: 'jsonrpc-stdio',
            terminalRequired: false,
            processExecution: 'broker-process',
          },
      presentationFulfillment: opts.presentationFulfillment ?? 'attachable',
      ...(opts.presentationSurface ? { presentationSurface: opts.presentationSurface } : {}),
      profile: {
        profileId: profile.profileId,
        profileHash: profile.profileHash,
        compatibilityHash: profile.compatibilityHash,
        startRequestHash: neutralStartRequestHash(startRequest),
      },
      dispatchRequest: { startRequest },
    },
    startRequest,
  }
}

/**
 * The terminal-hosted counterpart of makeSelectedExecution.  It retains the
 * legacy helper only to make the hash-bound broker start request; callers see
 * the final singular v2 execution declaration.
 */
export function makeSelectedInteractiveTmuxExecution(
  identity: RuntimeIdentityAllocation,
  opts: InteractiveTmuxFixtureOpts = {}
): { execution: SelectedExecution; startRequest: InvocationStartRequest } {
  const { profile, startRequest } = makeInteractiveTmuxProfile(identity, opts)
  return {
    execution: {
      recipeId: `fixture-${profile.brokerDriver}`,
      driver: profile.brokerDriver,
      protocol: 'harness-broker/0.2',
      hosting: {
        executionTransport: 'pty',
        terminalRequired: true,
        terminalHost: 'tmux',
        processExecution: 'broker-process',
      },
      presentationFulfillment: 'attachable',
      presentationSurface: { transport: 'terminal', terminalHost: 'tmux' },
      profile: {
        profileId: profile.profileId,
        profileHash: profile.profileHash,
        compatibilityHash: profile.compatibilityHash,
        startRequestHash: neutralStartRequestHash(startRequest),
      },
      dispatchRequest: { startRequest },
    },
    startRequest,
  }
}

export function makeSelectedExecutionPlan(
  opts: Partial<SelectedExecutionPlan> = {}
): SelectedExecutionPlan {
  return {
    schemaVersion: 'agent-runtime-plan/v2',
    planHash: 'planhash_v2_fixture',
    compileId: 'compile_v2_fixture',
    createdAt: '2026-09-22T00:00:00.000Z',
    diagnostics: [],
    selection: {
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      presentation: false,
      provenance: {
        harness: 'agent-profile',
        modelProvider: 'agent-profile',
        model: 'agent-profile',
        reasoningEffort: 'project-target',
        presentation: 'agent-profile',
      },
    },
    ...opts,
  }
}

export function makeHrcPolicy(): RuntimeCompileRequest['hrcPolicy'] {
  return {
    permissionPolicy: { mode: 'deny', audit: true },
    inputPolicy: {
      readyInput: 'start-turn',
      busy: { whenBusy: 'reject' },
      supportedKinds: ['user'],
      attachmentPolicy: { localImages: true, fileRefs: true },
    },
  }
}

/**
 * A deterministic identity allocation matching the headless-codex shape: an
 * initial user turn exists (initialInputId set) and the operation has a
 * user-visible turn (runId set).
 */
export function makeIdentity(
  overrides: Partial<RuntimeIdentityAllocation> = {}
): RuntimeIdentityAllocation {
  return {
    requestId: 'request_w2',
    operationId: 'runtimeOperation_w2',
    hostSessionId: 'hostSession_w2',
    generation: 1,
    runtimeId: 'runtime_w2',
    invocationId: 'invocation_w2',
    initialInputId: 'input_w2',
    runId: 'run_w2',
    traceId: 'trace_w2',
    ...overrides,
  } as RuntimeIdentityAllocation
}

export type FixtureOpts = {
  /** Override the spec.invocationId (to test identity mismatch). */
  invocationId?: string
  /** Override the initialInput.inputId (to test initial-input mismatch). */
  initialInputId?: NonNullable<InvocationStartRequest['initialInput']>['inputId'] | undefined
  /** Whether to include an initialInput at all. */
  withInitialInput?: boolean
  /**
   * The initial input's text. Callers that assert what HRC handed to compile
   * echo `materialization.initialPrompt` in here; the fixture deliberately does
   * NOT model the compiler's priming concatenation, which is real ASP behaviour
   * and provable only against the real compiler.
   */
  initialInputText?: string | undefined
  /** Profile-level diagnostics. */
  diagnostics?: unknown[]
  /** profileId for the candidate. */
  profileId?: string
  /** Override brokerDriver (to test non-codex). */
  brokerDriver?: string
  /** Override interactionMode (to test interactive rejection). */
  interactionMode?: 'headless' | 'interactive' | 'nonInteractive'
  /** Override broker terminal metadata. */
  brokerTerminal?: { host: 'tmux' | string }
}

/**
 * Build a historical v1 profile fixture whose start request hashes are honest.
 * Production compilation accepts only the singular v2 execution envelope.
 */
export function makeBrokerProfile(
  identity: RuntimeIdentityAllocation,
  opts: FixtureOpts = {}
): { profile: LegacyBrokerExecutionProfile; startRequest: InvocationStartRequest } {
  const invocationId = (opts.invocationId ?? identity.invocationId) as
    | RuntimeIdentityAllocation['invocationId']
    | undefined
  const withInitialInput = opts.withInitialInput ?? identity.initialInputId !== undefined
  const initialInputId = opts.initialInputId ?? identity.initialInputId

  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
    process: {
      command: 'codex',
      args: ['app-server'],
      cwd: '/tmp/work',
      lockedEnv: { CODEX_HOME: '/tmp/work/.codex' },
      harnessTransport: { kind: 'jsonrpc-stdio' },
    },
    interaction: { mode: 'headless', turnConcurrency: 'single' },
    driver: { kind: 'codex-app-server', model: 'gpt-5-codex' },
    correlation: {
      requestId: String(identity.requestId),
      operationId: String(identity.operationId),
      runtimeId: String(identity.runtimeId),
      invocationId: String(invocationId),
    },
  }

  const startRequest: InvocationStartRequest = {
    spec,
    ...(withInitialInput && initialInputId !== undefined
      ? {
          initialInput: {
            inputId: initialInputId,
            kind: 'user',
            content: [{ type: 'text', text: opts.initialInputText ?? 'hello broker' }],
          },
        }
      : {}),
  }

  const specHash = neutralSpecHash(spec)
  const startRequestHash = neutralStartRequestHash(startRequest)

  const profile = {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: opts.profileId ?? 'profile_codex_headless',
    profileHash: 'profilehash_codex_headless',
    compatibilityHash: 'compat_codex_headless',
    kind: 'harness-broker',
    interactionMode: opts.interactionMode ?? 'headless',
    // T-01866 — v0.2 is the only active broker protocol (v0.1 decommissioned).
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: opts.brokerDriver ?? 'codex-app-server',
    brokerOwnership: 'hrc-owned-process',
    ...(opts.brokerTerminal ? { brokerTerminal: opts.brokerTerminal } : {}),
    expectedCapabilities: {},
    harnessInvocation: { startRequest, specHash, startRequestHash },
    policy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {},
      exposurePolicy: {},
    },
    observability: {},
    ...(opts.diagnostics ? { diagnostics: opts.diagnostics } : {}),
  } satisfies LegacyBrokerExecutionProfile

  return { profile, startRequest }
}

/** Options for shaping the interactive tmux fixture's launch / initialInput shape. */
export type InteractiveTmuxFixtureOpts = {
  brokerDriver?: 'claude-code-tmux' | 'codex-app-server' | 'codex-cli-tmux' | 'pi-tui-tmux'
  /**
   * When set, attach `spec.launch.initialPrompt` (the launch-argv priming shape).
   * Included in spec hashing, so the priming is hash-bound and invocationId-bound.
   */
  launchInitialPrompt?: string
  /** T-08560: the text of the broker initialInput, when one is included. */
  initialInputText?: string
  /**
   * Force-include (true) or omit (false) the broker initialInput. Defaults to
   * including it whenever `identity.initialInputId` is allocated — the OLD
   * compiler shape. Set false to model the new launch-primed shape where the
   * priming rides the launch argv and there is no broker initialInput.
   */
  withInitialInput?: boolean
  /** Override the initialInput.inputId (to test a stale/mismatched echo). */
  initialInputId?: NonNullable<InvocationStartRequest['initialInput']>['inputId']
}

/** An interactive claude-code-tmux broker profile. */
export function makeInteractiveTmuxProfile(
  identity: RuntimeIdentityAllocation = makeIdentity({
    runtimeId: 'runtime_tmux' as RuntimeIdentityAllocation['runtimeId'],
    invocationId: 'invocation_tmux' as RuntimeIdentityAllocation['invocationId'],
  }),
  opts: InteractiveTmuxFixtureOpts = {}
): { profile: LegacyBrokerExecutionProfile; startRequest: InvocationStartRequest } {
  const withInitialInput = opts.withInitialInput ?? identity.initialInputId !== undefined
  const initialInputId = opts.initialInputId ?? identity.initialInputId
  const brokerDriver = opts.brokerDriver ?? 'claude-code-tmux'
  const frontend =
    brokerDriver === 'claude-code-tmux'
      ? 'claude'
      : brokerDriver === 'codex-cli-tmux' || brokerDriver === 'codex-app-server'
        ? 'codex-cli'
        : 'pi-cli'
  const provider = brokerDriver === 'claude-code-tmux' ? 'anthropic' : 'openai'
  const command =
    brokerDriver === 'claude-code-tmux'
      ? 'claude'
      : brokerDriver === 'codex-cli-tmux' || brokerDriver === 'codex-app-server'
        ? 'codex'
        : 'pi'
  const lockedEnv =
    brokerDriver === 'claude-code-tmux'
      ? { CLAUDE_CONFIG_DIR: '/tmp/work/.claude' }
      : brokerDriver === 'codex-cli-tmux' || brokerDriver === 'codex-app-server'
        ? { CODEX_HOME: '/tmp/work/.codex' }
        : { PI_CODING_AGENT_DIR: '/tmp/work/.pi-agent' }
  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: identity.invocationId,
    harness: { frontend, provider, driver: brokerDriver },
    process: {
      command,
      args: ['--dangerously-skip-permissions'],
      cwd: '/tmp/work',
      lockedEnv,
      harnessTransport: { kind: 'pty' },
    },
    interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: { kind: brokerDriver },
    ...(opts.launchInitialPrompt !== undefined
      ? { launch: { initialPrompt: opts.launchInitialPrompt } }
      : {}),
    correlation: {
      requestId: String(identity.requestId),
      operationId: String(identity.operationId),
      runtimeId: String(identity.runtimeId),
      invocationId: String(identity.invocationId),
    },
  }
  const startRequest: InvocationStartRequest = {
    spec,
    ...(withInitialInput && initialInputId !== undefined
      ? {
          initialInput: {
            inputId: initialInputId,
            kind: 'user',
            content: [{ type: 'text', text: opts.initialInputText ?? `hello ${brokerDriver}` }],
          },
        }
      : {}),
  }
  const specHash = neutralSpecHash(spec)
  const startRequestHash = neutralStartRequestHash(startRequest)

  return {
    profile: {
      schemaVersion: 'agent-runtime-profile/v1',
      profileId: `profile_${brokerDriver}`,
      profileHash: `profilehash_${brokerDriver}`,
      compatibilityHash: `compat_${brokerDriver}`,
      kind: 'harness-broker',
      interactionMode: 'interactive',
      // T-01866 — v0.2 is the only active broker protocol (v0.1 decommissioned).
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver,
      brokerOwnership: 'hrc-owned-process',
      brokerTerminal: { host: 'tmux' },
      expectedCapabilities: {},
      harnessInvocation: { startRequest, specHash, startRequestHash },
      policy: {
        permissionPolicy: { mode: 'deny', audit: true },
        inputPolicy: {},
        exposurePolicy: {},
      },
      observability: {},
    } satisfies LegacyBrokerExecutionProfile,
    startRequest,
  }
}

/** Wrap one-or-more profiles into a successful compile response. */
export function makeCompileResponse(
  identity: RuntimeIdentityAllocation,
  profiles: LegacyBrokerExecutionProfile[]
): LegacyRuntimeCompileResponse {
  const plan: Extract<LegacyRuntimeCompileResponse, { ok: true }>['plan'] = {
    schemaVersion: 'agent-runtime-plan/v1',
    compiler: { name: 'agent-spaces', version: '0.0.0-test' },
    compileId: 'compile_w2',
    planHash: 'planhash_w2',
    createdAt: '2026-05-27T00:00:00Z',
    identity,
    placement: {
      agentRoot: '/tmp/agent',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
    },
    resolvedBundle: { bundleIdentity: 'bundle_w2' },
    harness: { family: 'codex', runtime: 'codex-cli', provider: 'openai' },
    model: { provider: 'openai', modelId: 'gpt-5-codex' },
    executionProfiles: profiles,
    artifacts: { bundleIdentity: 'bundle_w2' },
    lockedEnv: { lockedEnvKeys: ['CODEX_HOME'] },
    diagnostics: [],
  }

  return {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: true,
    plan,
    diagnostics: [],
  }
}

/** A failed (ok:false) compile response. */
export function makeFailedCompileResponse(): LegacyRuntimeCompileResponse {
  return {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: false,
    diagnostics: [
      { level: 'error', code: 'compile-failed', message: 'boom', plane: 'asp-compiler' },
    ],
  }
}
