import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, test } from 'bun:test'
import type { HrcRuntimeIntent } from 'hrc-core'

import { isProducerSelectedOrdinaryBirth } from '../broker-decisions.js'
import { omitPersistedSelectionForReuse } from '../selector-message-handlers/selection-request.js'

const source = (path: string) => readFileSync(resolve(import.meta.dir, '..', path), 'utf8')

test('birth and presentation consumers do not import the retired v1 profile selector', () => {
  for (const path of [
    'aspd-headless-start.ts',
    'broker-headless-handlers.ts',
    'presentation-operator.ts',
  ]) {
    expect(source(path)).not.toContain('toProfileSelector')
  }
})

test('ASPD hosting has no driver-list or named-driver route authority', () => {
  const text = source('aspd-headless-start.ts')
  expect(text).not.toContain('hostedDrivers')
  expect(text).not.toContain('ASPD_BROKER_DRIVER')
  expect(text).not.toContain('ASPD_MUSE_BROKER_DRIVER')
})

test('ASPD accepts every admitted hosting process form rather than rejecting native-worker', () => {
  const text = source('aspd-headless-start.ts')
  expect(text).not.toContain("processExecution === 'broker-process'")
  expect(text).not.toContain("processExecution !== 'broker-process'")
  expect(text).not.toContain('aspd_execution_hosting_mismatch')
})

test('ordinary fresh births stay producer-selected for omission, explicit false, and every v2 harness', () => {
  const base = {
    placement: { kind: 'inline' } as unknown as HrcRuntimeIntent['placement'],
    // Deliberately conflicting legacy metadata: this must not classify an
    // ordinary v2 birth before ASP selects its frozen execution.
    harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
  } satisfies HrcRuntimeIntent

  for (const selection of [
    undefined,
    { harness: 'agent-harness' as const, presentation: false },
    { harness: 'claude' as const, presentation: false },
    { harness: 'codex' as const, presentation: false },
    { harness: 'muse' as const, presentation: false },
  ]) {
    expect(
      isProducerSelectedOrdinaryBirth({
        ...base,
        ...(selection === undefined ? {} : { selection }),
      })
    ).toBe(true)
  }
})

test('only an explicitly interactive presentation retains the interactive birth path', () => {
  const base = {
    placement: { kind: 'inline' } as unknown as HrcRuntimeIntent['placement'],
    harness: { provider: 'openai', interactive: true, id: 'codex-cli' },
  } satisfies HrcRuntimeIntent

  expect(isProducerSelectedOrdinaryBirth(base)).toBe(true)
  expect(isProducerSelectedOrdinaryBirth({ ...base, presentation: { operator: 'none' } })).toBe(
    true
  )
  expect(isProducerSelectedOrdinaryBirth({ ...base, presentation: { operator: 'tmux-tui' } })).toBe(
    false
  )
  expect(isProducerSelectedOrdinaryBirth({ ...base, presentation: { operator: 'observer' } })).toBe(
    false
  )
})

test('ordinary public start and turn enter producer-selected hosting before any legacy route decision', () => {
  for (const path of ['runtime-io-handlers.ts', 'turn-dispatch-handlers.ts']) {
    const text = source(path)
    const ordinary = text.indexOf('isProducerSelectedOrdinaryBirth(')
    const legacyRoute = text.indexOf('decideHeadlessExecutionRoute(', ordinary)
    expect(ordinary).toBeGreaterThanOrEqual(0)
    expect(legacyRoute).toBeGreaterThan(ordinary)
  }
})

test('stored request selection is omitted when a later door reuses its HRC policy', () => {
  const stored = {
    placement: { kind: 'inline' } as unknown as HrcRuntimeIntent['placement'],
    harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
    selection: { harness: 'claude' as const, presentation: false },
    summonDirectives: { model_provider: 'anthropic' },
  } satisfies HrcRuntimeIntent

  expect(omitPersistedSelectionForReuse(stored)).toEqual({
    placement: stored.placement,
    harness: stored.harness,
  })
})

test('selector ensure does not choose an interactive broker driver before compilation', () => {
  const text = source('selector-message-handlers.ts')
  expect(text).not.toContain('selectInteractiveTmuxBrokerOptions(')
  expect(text).not.toContain('isMatchingInteractiveTmuxBrokerRuntime(')
})
