/**
 * Table-driven coverage for `shouldUseHeadlessSdkExecutor`.
 *
 * This predicate is the single source of truth for routing decisions in
 * `handleHeadlessDispatchTurn`, `runHeadlessStartLaunch`,
 * `createHeadlessRuntimeForSession` (harness label), and
 * `getReusableHeadlessRuntimeForSession` (reuse filter). If the predicate
 * drifts, runtime identity, dispatch routing, and reuse safety all decouple.
 */
import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'

import { shouldUseHeadlessSdkExecutor } from '../index'

type HarnessInput = HrcRuntimeIntent['harness']

type Case = {
  name: string
  harness: HarnessInput
  expected: boolean
}

const cases: Case[] = [
  {
    name: 'explicit pi-sdk id → SDK executor',
    harness: { provider: 'openai', interactive: false, id: 'pi-sdk' },
    expected: true,
  },
  {
    name: 'explicit agent-sdk id → SDK executor',
    harness: { provider: 'anthropic', interactive: false, id: 'agent-sdk' },
    expected: true,
  },
  {
    name: 'explicit codex-cli id → CLI executor (not SDK)',
    harness: { provider: 'openai', interactive: true, id: 'codex-cli' },
    expected: false,
  },
  {
    name: 'explicit claude-code id → CLI executor',
    harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
    expected: false,
  },
  {
    name: 'explicit pi-cli id → CLI executor',
    harness: { provider: 'openai', interactive: true, id: 'pi-cli' },
    expected: false,
  },
  {
    name: 'id-less anthropic → legacy SDK fallback',
    harness: { provider: 'anthropic', interactive: false },
    expected: true,
  },
  {
    name: 'id-less openai → CLI executor (preserves existing regression)',
    harness: { provider: 'openai', interactive: false },
    expected: false,
  },
]

describe('shouldUseHeadlessSdkExecutor', () => {
  for (const { name, harness, expected } of cases) {
    it(name, () => {
      expect(shouldUseHeadlessSdkExecutor(harness)).toBe(expected)
    })
  }
})
