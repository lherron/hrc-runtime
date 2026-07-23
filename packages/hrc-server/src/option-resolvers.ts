import { join, resolve } from 'node:path'

import { HrcRuntimeUnavailableError } from 'hrc-core'

import { AspcFacadeBrokerClient } from './agent-spaces-adapter/aspc-facade-client.js'
import { isFalsyFeatureFlag, isTruthyFeatureFlag } from './broker-decisions.js'
import {
  type PrecompileLaunchTimingContext,
  observePrecompileLaunchSpan,
} from './precompile-launch-timing.js'
import {
  DEFAULT_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES,
  DEFAULT_HRC_MAIL_KICKER_SWEEP_INTERVAL_MS,
  DEFAULT_HRC_MAIL_MAX_ROUNDS,
  DEFAULT_STALE_GENERATION_THRESHOLD_SEC,
  HRC_BROKER_DURABLE_IPC_ENABLED_ENV,
  HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED_ENV,
  HRC_CODEX_CLI_TMUX_BROKER_ENABLED_ENV,
  HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
  HRC_MAIL_KICKER_ENABLED_ENV,
  HRC_MAIL_MAX_ROUNDS_ENV,
  HRC_PI_TUI_TMUX_BROKER_ENABLED_ENV,
} from './server-constants.js'
import type { HrcServerOptions } from './server-types.js'

/** Workspace root derived from this module's location (packages/hrc-server/src/option-resolvers.ts → ../../..) */
const WORKSPACE_ROOT = resolve(import.meta.dir, '..', '..', '..')

const HRC_ASPC_FACADE_CMD_ENV = 'HRC_ASPC_FACADE_CMD'
const HRC_ASPC_FACADE_ARGS_ENV = 'HRC_ASPC_FACADE_ARGS'
const DEFAULT_ASPC_FACADE_COMMAND = join(WORKSPACE_ROOT, 'node_modules', '.bin', 'aspc-facade')
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

/**
 * Resolve a boolean feature flag: an explicit `options` override always wins;
 * otherwise consult the env var. `defaultOn` selects the env semantics —
 * `true` means default-ON (enabled unless an explicit falsy flag), `false`
 * means default-OFF (dark unless an explicit truthy flag). The asymmetry is
 * intentional and load-bearing (broker cutover flags default ON; durable-IPC
 * dark), so each call site passes `defaultOn` explicitly.
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

export function resolveHrcMailMaxRounds(options: HrcServerOptions): number {
  const override = options.hrcMailMaxRounds
  if (typeof override === 'number' && Number.isSafeInteger(override) && override > 0) {
    return override
  }
  const raw = process.env[HRC_MAIL_MAX_ROUNDS_ENV]
  if (raw === undefined) return DEFAULT_HRC_MAIL_MAX_ROUNDS
  const parsed = Number(raw.trim())
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_HRC_MAIL_MAX_ROUNDS
}

export function resolveAspcFacadeStartOptions(): { command: string; args: string[] } {
  const command = process.env[HRC_ASPC_FACADE_CMD_ENV]?.trim() || DEFAULT_ASPC_FACADE_COMMAND
  const rawArgs = process.env[HRC_ASPC_FACADE_ARGS_ENV]
  const args =
    rawArgs === undefined
      ? DEFAULT_ASPC_FACADE_ARGS
      : rawArgs
          .split(/\s+/)
          .map((arg) => arg.trim())
          .filter((arg) => arg.length > 0)
  return { command, args }
}

export async function startAspcFacadeBrokerClient(
  timing?: PrecompileLaunchTimingContext | undefined
): Promise<AspcFacadeBrokerClient> {
  const startClient = () =>
    AspcFacadeBrokerClient.start({
      ...resolveAspcFacadeStartOptions(),
      env: process.env as Record<string, string>,
    })
  const client = timing
    ? await observePrecompileLaunchSpan('precompile-facade-spawn', timing, startClient)
    : await startClient()
  try {
    const hello = timing
      ? await observePrecompileLaunchSpan('precompile-facade-hello', timing, () => client.hello())
      : await client.hello()
    if (!hello.capabilities.compileHarnessInvocation) {
      throw new HrcRuntimeUnavailableError(
        'ASPC facade does not support harness invocation compilation',
        {
          facadeInfo: hello.facadeInfo,
          protocolVersion: hello.protocolVersion,
        }
      )
    }
    if (!hello.capabilities.cohostedBroker) {
      throw new HrcRuntimeUnavailableError('ASPC facade did not co-host a broker', {
        facadeInfo: hello.facadeInfo,
        protocolVersion: hello.protocolVersion,
      })
    }
    return client
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }
}

export function resolveClaudeGhosttyIdleCleanupMinutes(): number {
  const raw = process.env['HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES']
  if (raw === undefined) return DEFAULT_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES
  const minutes = Number.parseFloat(raw)
  if (!Number.isFinite(minutes) || minutes < 0) {
    return DEFAULT_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES
  }
  return minutes
}
