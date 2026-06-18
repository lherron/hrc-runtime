/**
 * Shared fixtures for the W2 broker compile-adapter + profile-selector red tests
 * (T-01695 / T-01690 Harness Broker cutover, headless codex-app-server only).
 *
 * These are synthetic compiled plans built with the EXPORTED spaces-runtime-contracts
 * hash-projection helper (`project`). No live compiler/broker is required.
 *
 * NOTE: this file is intentionally NOT a `*.test.ts` so the bun runner does not
 * execute it directly; it is imported by the red test files. It also is NOT named
 * `compile-*.ts` and does not live under `src/agent-spaces-adapter/`, so it is
 * outside the W1A broker-path boundary guard.
 */

import type { HarnessInvocationSpec, InvocationStartRequest } from 'spaces-harness-broker-protocol'
import { project } from 'spaces-runtime-contracts'
import type {
  BrokerExecutionProfile,
  CompiledRuntimePlan,
  RuntimeCompileResponse,
  RuntimeIdentityAllocation,
} from 'spaces-runtime-contracts'

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
  initialInputId?: string | undefined
  /** Whether to include an initialInput at all. */
  withInitialInput?: boolean
  /** Profile-level diagnostics. */
  diagnostics?: CompiledRuntimePlan['diagnostics']
  /** profileId for the candidate. */
  profileId?: string
  /** Override brokerDriver (to test non-codex). */
  brokerDriver?: string
  /** Override interactionMode (to test interactive rejection). */
  interactionMode?: 'headless' | 'interactive'
  /** Override broker terminal metadata. */
  brokerTerminal?: { host: 'tmux' | string }
}

/**
 * Build a single valid headless codex-app-server BrokerExecutionProfile whose
 * specHash + startRequestHash are computed honestly via `project()`.
 */
export function makeBrokerProfile(
  identity: RuntimeIdentityAllocation,
  opts: FixtureOpts = {}
): { profile: BrokerExecutionProfile; startRequest: InvocationStartRequest } {
  const invocationId = (opts.invocationId ?? identity.invocationId) as
    | RuntimeIdentityAllocation['invocationId']
    | undefined
  const withInitialInput = opts.withInitialInput ?? identity.initialInputId !== undefined

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
    ...(withInitialInput
      ? {
          initialInput: {
            inputId: (opts.initialInputId ?? identity.initialInputId) as string,
            kind: 'user',
            content: [{ type: 'text', text: 'hello broker' }],
          },
        }
      : {}),
  } as InvocationStartRequest

  const specHash = (project(spec, 'spec') as { specHash: string }).specHash
  const startRequestHash = (project(startRequest, 'start-request') as { startRequestHash: string })
    .startRequestHash

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
  } as unknown as BrokerExecutionProfile

  return { profile, startRequest }
}

/** Options for shaping the interactive tmux fixture's launch / initialInput shape. */
export type InteractiveTmuxFixtureOpts = {
  brokerDriver?: 'claude-code-tmux' | 'codex-cli-tmux' | 'pi-tui-tmux'
  /**
   * When set, attach `spec.launch.initialPrompt` (the launch-argv priming shape).
   * Included in spec hashing, so the priming is hash-bound and invocationId-bound.
   */
  launchInitialPrompt?: string
  /**
   * Force-include (true) or omit (false) the broker initialInput. Defaults to
   * including it whenever `identity.initialInputId` is allocated — the OLD
   * compiler shape. Set false to model the new launch-primed shape where the
   * priming rides the launch argv and there is no broker initialInput.
   */
  withInitialInput?: boolean
  /** Override the initialInput.inputId (to test a stale/mismatched echo). */
  initialInputId?: string
}

/** An interactive claude-code-tmux broker profile. */
export function makeInteractiveTmuxProfile(
  identity: RuntimeIdentityAllocation = makeIdentity({
    runtimeId: 'runtime_tmux' as RuntimeIdentityAllocation['runtimeId'],
    invocationId: 'invocation_tmux' as RuntimeIdentityAllocation['invocationId'],
  }),
  opts: InteractiveTmuxFixtureOpts = {}
): { profile: BrokerExecutionProfile; startRequest: InvocationStartRequest } {
  const withInitialInput = opts.withInitialInput ?? identity.initialInputId !== undefined
  const brokerDriver = opts.brokerDriver ?? 'claude-code-tmux'
  const frontend =
    brokerDriver === 'claude-code-tmux'
      ? 'claude'
      : brokerDriver === 'codex-cli-tmux'
        ? 'codex-cli'
        : 'pi-cli'
  const provider = brokerDriver === 'claude-code-tmux' ? 'anthropic' : 'openai'
  const command =
    brokerDriver === 'claude-code-tmux'
      ? 'claude'
      : brokerDriver === 'codex-cli-tmux'
        ? 'codex'
        : 'pi'
  const lockedEnv =
    brokerDriver === 'claude-code-tmux'
      ? { CLAUDE_CONFIG_DIR: '/tmp/work/.claude' }
      : brokerDriver === 'codex-cli-tmux'
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
    ...(withInitialInput && identity.initialInputId
      ? {
          initialInput: {
            inputId: (opts.initialInputId ?? identity.initialInputId) as string,
            kind: 'user',
          content: [{ type: 'text', text: `hello ${brokerDriver}` }],
          },
        }
      : {}),
  } as InvocationStartRequest
  const specHash = (project(spec, 'spec') as { specHash: string }).specHash
  const startRequestHash = (project(startRequest, 'start-request') as { startRequestHash: string })
    .startRequestHash

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
    } as unknown as BrokerExecutionProfile,
    startRequest,
  }
}

/** Wrap one-or-more profiles into a successful compile response. */
export function makeCompileResponse(
  identity: RuntimeIdentityAllocation,
  profiles: BrokerExecutionProfile[]
): RuntimeCompileResponse {
  const plan = {
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
  } as unknown as CompiledRuntimePlan

  return {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: true,
    plan,
    diagnostics: [],
  } as RuntimeCompileResponse
}

/** A failed (ok:false) compile response. */
export function makeFailedCompileResponse(): RuntimeCompileResponse {
  return {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: false,
    diagnostics: [
      { level: 'error', code: 'compile-failed', message: 'boom', plane: 'asp-compiler' },
    ],
  } as RuntimeCompileResponse
}
