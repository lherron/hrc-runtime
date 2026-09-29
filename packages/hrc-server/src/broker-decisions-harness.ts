import type {
  HrcContinuationRef,
  HrcHarness,
  HrcProvider,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import { harnessFrontendToHrcHarness } from 'hrc-core'
import type { RuntimeContinuationRef } from 'spaces-runtime-contracts'
import { timestamp } from './server-util.js'

/**
 * Ordinary v2 birth has no HRC-side harness/provider/driver route.  ASP owns
 * selection and returns the frozen execution/hosting contract.  The only
 * retained local birth distinction is an explicitly requested operator
 * surface: it needs the legacy interactive attach choreography before an
 * execution exists.
 *
 * `selection.presentation: false` is intentionally not read here. It is a
 * producer compile override, not an HRC viewer route choice.
 */
export function isProducerSelectedOrdinaryBirth(intent: HrcRuntimeIntent): boolean {
  const operator = intent.presentation?.operator
  if (operator === 'observer') return false
  if (operator !== 'tmux-tui') return true
  return (
    intent.harness.provider === undefined &&
    intent.harness.id === undefined &&
    intent.harness.interactive !== true &&
    intent.execution?.preferredMode !== 'interactive'
  )
}

export function deriveInteractiveHarness(
  harness: HrcRuntimeIntent['harness']
): HrcRuntimeSnapshot['harness'] {
  if (harness.id === 'pi') {
    return 'pi'
  }
  if (harness.id === 'pi-cli' || harness.id === 'codex-cli' || harness.id === 'claude-code') {
    return harness.id
  }
  return harness.provider === 'openai' ? 'codex-cli' : 'claude-code'
}

function selectionProviderForContinuation(
  provider: HrcContinuationRef['provider']
): HrcProvider | undefined {
  switch (provider) {
    case 'anthropic':
      return 'anthropic'
    case 'openai':
    case 'codex':
    case 'openai-codex':
      return 'openai'
    case 'meta':
    case 'muse':
      return 'meta'
    default:
      return undefined
  }
}

export function toRuntimeContinuationRef(
  continuation: HrcContinuationRef | undefined
): RuntimeContinuationRef | undefined {
  if (continuation?.key === undefined) {
    return undefined
  }
  const selectionProvider = selectionProviderForContinuation(continuation.provider)
  if (selectionProvider === undefined) {
    return undefined
  }
  return {
    schemaVersion: 'runtime-continuation/v1',
    hrc: {
      provider: selectionProvider,
      continuationId: continuation.key,
      key: continuation.key,
    },
    broker: {
      provider: continuation.provider,
      ...(continuation.kind !== undefined ? { kind: continuation.kind } : {}),
      continuationId: continuation.key,
      key: continuation.key,
    },
    source: 'harness-broker',
    observedAt: timestamp(),
  }
}

export function deriveSdkHarness(
  harness: HrcRuntimeIntent['harness']
): HrcRuntimeSnapshot['harness'] {
  if (harness.id === 'agent-sdk' || harness.id === 'pi-sdk') {
    return harness.id
  }
  // HRC's SDK-executor routing (not catalog interpretation): the anthropic
  // SDK lane serves anthropic, the pi SDK lane serves openai; anything else
  // keeps the legacy SDK fallback. Matches resolveHarnessFrontendForProvider
  // byte-for-byte over the admitted provider set.
  const frontend =
    harness.provider === 'anthropic'
      ? 'agent-sdk'
      : harness.provider === 'openai'
        ? 'pi-sdk'
        : undefined
  const admitted = harnessFrontendToHrcHarness(frontend)
  // Only HRC-known harness ids pass through; anything else keeps the legacy SDK fallback.
  return admitted !== undefined && isHrcHarness(admitted) ? admitted : 'agent-sdk'
}

const HRC_HARNESS_IDS: ReadonlySet<string> = new Set<HrcHarness>([
  'agent-sdk',
  'claude-code',
  'codex-cli',
  'pi',
  'pi-cli',
  'pi-sdk',
])

function isHrcHarness(value: string): value is HrcHarness {
  return HRC_HARNESS_IDS.has(value)
}

/**
 * Decide whether a headless dispatch (or start) should select the SDK route
 * rather than the CLI route. Explicit agent-sdk always wins; explicit
 * pi-sdk is broker-owned and never enters the SDK fallback.
 * Id-less Anthropic intents keep the legacy SDK fallback only after the caller
 * has already selected the headless path.
 *
 * Exported for unit testing — single-source predicate for dispatch routing,
 * start routing, runtime harness label (`deriveSdkHarness` vs
 * `deriveInteractiveHarness`), and reuse filtering.
 */
export function shouldUseHeadlessSdkExecutor(harness: HrcRuntimeIntent['harness']): boolean {
  if (harness.id === 'agent-sdk') {
    return true
  }
  if (harness.id !== undefined) {
    return false
  }
  return harness.provider === 'anthropic'
}
