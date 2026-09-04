import { HrcRuntimeUnavailableError } from 'hrc-core'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import type { AspcHelloResponse } from 'spaces-aspc-protocol'

import { AspcFacadeBrokerClient } from './agent-spaces-adapter/aspc-facade-client.js'
import {
  externalToolchainContractDriftDetail,
  observeAspToolchainHello,
  resolveAspToolchainBinary,
} from './asp-toolchain.js'
import { isFalsyFeatureFlag, isTruthyFeatureFlag } from './broker-decisions.js'
import {
  type PrecompileLaunchTimingContext,
  observePrecompileLaunchSpan,
} from './precompile-launch-timing.js'
import {
  DEFAULT_HRC_MAIL_KICKER_SWEEP_INTERVAL_MS,
  DEFAULT_HRC_TRANSCRIPT_INDEX_TICK_INTERVAL_MS,
  DEFAULT_SESSION_IDLE_ARCHIVE_DAYS,
  DEFAULT_SESSION_PROJECTION_DAYS,
  DEFAULT_STALE_GENERATION_THRESHOLD_SEC,
  HRC_AGENT_HARNESS_TMUX_BROKER_ENABLED_ENV,
  HRC_BROKER_DURABLE_IPC_ENABLED_ENV,
  HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED_ENV,
  HRC_CODEX_CLI_TMUX_BROKER_ENABLED_ENV,
  HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
  HRC_MAIL_KICKER_ENABLED_ENV,
  HRC_PI_TUI_TMUX_BROKER_ENABLED_ENV,
  HRC_SESSION_IDLE_ARCHIVE_DAYS_ENV,
  HRC_SESSION_PROJECTION_DAYS_ENV,
  HRC_TMUX_AGING_ENABLED_ENV,
  HRC_TRANSCRIPT_INDEX_ENABLED_ENV,
  HRC_TRANSCRIPT_INDEX_TICK_MS_ENV,
} from './server-constants.js'
import type { HrcServerOptions } from './server-types.js'

const HRC_ASPC_FACADE_ARGS_ENV = 'HRC_ASPC_FACADE_ARGS'
const DEFAULT_ASPC_FACADE_ARGS = ['run', '--transport', 'stdio']

export function resolveStaleGenerationEnabled(options: HrcServerOptions): boolean {
  if (typeof options.staleGenerationEnabled === 'boolean') {
    return options.staleGenerationEnabled
  }
  const raw = process.env['HRC_STALE_GENERATION_ENABLED']
  if (raw === undefined) return true
  const normalized = raw.trim().toLowerCase()
  return !(normalized === '0' || normalized === 'false' || normalized === 'no')
}

export function resolveStaleGenerationThresholdSec(options: HrcServerOptions): number {
  if (typeof options.staleGenerationThresholdSec === 'number') {
    return Math.max(0, Math.floor(options.staleGenerationThresholdSec))
  }
  const raw = process.env['HRC_STALE_GENERATION_HOURS']
  if (raw === undefined) return DEFAULT_STALE_GENERATION_THRESHOLD_SEC
  const hours = Number.parseFloat(raw)
  if (!Number.isFinite(hours) || hours < 0) {
    return DEFAULT_STALE_GENERATION_THRESHOLD_SEC
  }
  return Math.floor(hours * 60 * 60)
}

export function resolveTmuxAgingEnabled(options: HrcServerOptions): boolean {
  return resolveBooleanFlag(options.tmuxAgingEnabled, process.env[HRC_TMUX_AGING_ENABLED_ENV], {
    defaultOn: true,
  })
}

/**
 * Resolve a boolean feature flag: an explicit `options` override always wins;
 * otherwise consult the env var. `defaultOn` selects the env semantics —
 * `true` means default-ON (enabled unless an explicit falsy flag), `false`
 * means default-OFF (dark unless an explicit truthy flag). The asymmetry is
 * intentional and load-bearing (each cutover chooses its own rollout default),
 * so each call site passes `defaultOn` explicitly.
 */
function resolveBooleanFlag(
  override: boolean | undefined,
  envValue: string | undefined,
  { defaultOn }: { defaultOn: boolean }
): boolean {
  if (typeof override === 'boolean') {
    return override
  }
  return defaultOn ? !isFalsyFeatureFlag(envValue) : isTruthyFeatureFlag(envValue)
}

export function resolveHeadlessCodexBrokerEnabled(options: HrcServerOptions): boolean {
  return resolveBooleanFlag(
    options.headlessCodexBrokerEnabled,
    process.env[HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV],
    { defaultOn: true }
  )
}

export function resolveClaudeCodeTmuxBrokerEnabled(options: HrcServerOptions): boolean {
  return resolveBooleanFlag(
    options.claudeCodeTmuxBrokerEnabled,
    process.env[HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED_ENV],
    { defaultOn: true }
  )
}

export function resolveCodexCliTmuxBrokerEnabled(options: HrcServerOptions): boolean {
  return resolveBooleanFlag(
    options.codexCliTmuxBrokerEnabled,
    process.env[HRC_CODEX_CLI_TMUX_BROKER_ENABLED_ENV],
    { defaultOn: true }
  )
}

export function resolvePiTuiTmuxBrokerEnabled(options: HrcServerOptions): boolean {
  return resolveBooleanFlag(
    options.piTuiTmuxBrokerEnabled,
    process.env[HRC_PI_TUI_TMUX_BROKER_ENABLED_ENV],
    { defaultOn: true }
  )
}

export function resolveAgentHarnessTmuxBrokerEnabled(options: HrcServerOptions): boolean {
  return resolveBooleanFlag(
    options.agentHarnessTmuxBrokerEnabled,
    process.env[HRC_AGENT_HARNESS_TMUX_BROKER_ENABLED_ENV],
    { defaultOn: true }
  )
}

/**
 * T-01810 (T-01801 Phase 1) — durable Unix-IPC broker route flag. OFF by default
 * (truthy-only), UNLIKE the default-on broker cutover flags above: the route is
 * dark until explicitly enabled. An explicit `options` override wins over env.
 */
export function resolveBrokerDurableIpcEnabled(options: HrcServerOptions): boolean {
  return resolveBooleanFlag(
    options.brokerDurableIpcEnabled,
    process.env[HRC_BROKER_DURABLE_IPC_ENABLED_ENV],
    { defaultOn: false }
  )
}

export function resolveHrcMailKickerEnabled(options: HrcServerOptions): boolean {
  return resolveBooleanFlag(
    options.hrcMailKickerEnabled,
    process.env[HRC_MAIL_KICKER_ENABLED_ENV],
    { defaultOn: false }
  )
}

export function resolveHrcMailKickerSweepIntervalMs(options: HrcServerOptions): number {
  const value = options.hrcMailKickerSweepIntervalMs
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.max(10, Math.floor(value))
  }
  return DEFAULT_HRC_MAIL_KICKER_SWEEP_INTERVAL_MS
}

export function resolveHrcTranscriptIndexEnabled(options: HrcServerOptions): boolean {
  return resolveBooleanFlag(
    options.hrcTranscriptIndexEnabled,
    process.env[HRC_TRANSCRIPT_INDEX_ENABLED_ENV],
    { defaultOn: true }
  )
}

export function resolveHrcTranscriptIndexTickIntervalMs(options: HrcServerOptions): number {
  const override = options.hrcTranscriptIndexTickIntervalMs
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.max(10, Math.floor(override))
  }
  const raw = process.env[HRC_TRANSCRIPT_INDEX_TICK_MS_ENV]
  if (raw !== undefined) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(10, Math.floor(parsed))
  }
  return DEFAULT_HRC_TRANSCRIPT_INDEX_TICK_INTERVAL_MS
}

function resolveAspcFacadeArgs(env: Record<string, string | undefined>): string[] {
  const rawArgs = env[HRC_ASPC_FACADE_ARGS_ENV]
  return rawArgs === undefined
    ? DEFAULT_ASPC_FACADE_ARGS
    : rawArgs
        .split(/\s+/)
        .map((arg) => arg.trim())
        .filter((arg) => arg.length > 0)
}

export function resolveAspcFacadeStartOptions(
  env: Record<string, string | undefined> = process.env
): { command: string; args: string[] } {
  const command = resolveAspToolchainBinary('aspc-facade', env).path
  const args = resolveAspcFacadeArgs(env)
  return { command, args }
}

export function assertAspcFacadeHello(
  selection: ReturnType<typeof resolveAspToolchainBinary>,
  hello: AspcHelloResponse
): void {
  const externalDrift = externalToolchainContractDriftDetail(selection)
  if (hello.protocolVersion !== ASPC_PROTOCOL_VERSION) {
    throw new HrcRuntimeUnavailableError(
      externalDrift?.remedy ??
        `ASPC facade selected unsupported protocol ${hello.protocolVersion}; HRC requires ${ASPC_PROTOCOL_VERSION}`,
      {
        facadeInfo: hello.facadeInfo,
        protocolVersion: hello.protocolVersion,
        requiredProtocolVersion: ASPC_PROTOCOL_VERSION,
        ...(externalDrift ?? {}),
      }
    )
  }
  if (!hello.capabilities.compileHarnessInvocation) {
    throw new HrcRuntimeUnavailableError(
      externalDrift?.remedy ?? 'ASPC facade does not support harness invocation compilation',
      {
        facadeInfo: hello.facadeInfo,
        protocolVersion: hello.protocolVersion,
        ...(externalDrift ?? {}),
      }
    )
  }
  if (!hello.capabilities.cohostedBroker) {
    throw new HrcRuntimeUnavailableError(
      externalDrift?.remedy ?? 'ASPC facade did not co-host a broker',
      {
        facadeInfo: hello.facadeInfo,
        protocolVersion: hello.protocolVersion,
        ...(externalDrift ?? {}),
      }
    )
  }
}

export async function startAspcFacadeBrokerClient(
  timing?: PrecompileLaunchTimingContext | undefined
): Promise<AspcFacadeBrokerClient> {
  // Resolve once, immediately before this spawn. In particular, do not move
  // this back to module load: agent-spaces bun-links may advance while HRC lives.
  const selection = resolveAspToolchainBinary('aspc-facade')
  const startClient = () =>
    AspcFacadeBrokerClient.start({
      command: selection.path,
      args: resolveAspcFacadeArgs(process.env),
      env: process.env as Record<string, string>,
    })
  const client = timing
    ? await observePrecompileLaunchSpan('precompile-facade-spawn', timing, startClient)
    : await startClient()
  try {
    const hello = timing
      ? await observePrecompileLaunchSpan('precompile-facade-hello', timing, () => client.hello())
      : await client.hello()
    observeAspToolchainHello(selection, {
      name: hello.facadeInfo.name,
      version: hello.facadeInfo.version,
      protocolVersion: hello.protocolVersion,
    })
    assertAspcFacadeHello(selection, hello)
    return client
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }
}

/**
 * Read a non-negative day count from the environment, falling back to
 * `fallbackDays` for anything absent, unparseable or negative. Zero is a legal
 * value and means "the window is empty" — for the projection window that is a
 * deliberate way to see only live-runtime sessions.
 */
function resolveRetentionDays(envName: string, fallbackDays: number): number {
  const raw = process.env[envName]
  if (raw === undefined) return fallbackDays
  const days = Number.parseFloat(raw)
  if (!Number.isFinite(days) || days < 0) return fallbackDays
  return days
}

/**
 * T-07575 — how far back an unscoped `GET /v1/sessions` reaches by default.
 * Sessions outside the window are still stored and still reachable, via
 * `?all=true`, `?updatedSince=`, or a scoped read; they are simply not what a
 * caller gets for asking a question with no bounds in it.
 */
export function resolveSessionProjectionDays(): number {
  return resolveRetentionDays(HRC_SESSION_PROJECTION_DAYS_ENV, DEFAULT_SESSION_PROJECTION_DAYS)
}

/**
 * T-07575 — how long a session may keep claiming `status: 'active'` after its
 * last activity before the retention sweep archives it.
 */
export function resolveSessionIdleArchiveDays(): number {
  return resolveRetentionDays(HRC_SESSION_IDLE_ARCHIVE_DAYS_ENV, DEFAULT_SESSION_IDLE_ARCHIVE_DAYS)
}
