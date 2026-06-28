import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildHrcRuntimeIntent, resolveAgentHarness } from './resolve-intent.js'

const tempRoots: string[] = []

function makeAgentDir(harness: string): { agentRoot: string; agentId: string } {
  const root = mkdtempSync(join(tmpdir(), 'hrc-sdk-resolve-intent-'))
  tempRoots.push(root)
  writeFileSync(
    join(root, 'agent-profile.toml'),
    `schemaVersion = 2\n\n[identity]\nharness = "${harness}"\n`
  )
  return { agentRoot: root, agentId: 'fixture-agent' }
}

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('resolveAgentHarness — provider/harness derived from the agent profile', () => {
  test('codex profile resolves to openai', () => {
    const { agentRoot, agentId } = makeAgentDir('codex')
    expect(resolveAgentHarness({ agentRoot, agentId })).toMatchObject({
      provider: 'openai',
      harness: 'codex',
    })
  })

  test('claude-code profile resolves to anthropic', () => {
    const { agentRoot, agentId } = makeAgentDir('claude-code')
    expect(resolveAgentHarness({ agentRoot, agentId })).toMatchObject({
      provider: 'anthropic',
      harness: 'claude-code',
    })
  })

  test('missing profile falls back to anthropic', () => {
    const root = mkdtempSync(join(tmpdir(), 'hrc-sdk-resolve-intent-empty-'))
    tempRoots.push(root)
    expect(resolveAgentHarness({ agentRoot: root, agentId: 'x' })).toMatchObject({
      provider: 'anthropic',
      harness: undefined,
    })
  })
})

describe('buildHrcRuntimeIntent — single authority for scoperef → HrcRuntimeIntent', () => {
  test('codex agent → openai + codex-cli harness id', () => {
    const { agentRoot, agentId } = makeAgentDir('codex')
    const intent = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      cwd: '/repo',
      runMode: 'task',
      interactive: false,
      preferredMode: 'headless',
    })
    expect(intent.harness).toMatchObject({
      provider: 'openai',
      id: 'codex-cli',
      interactive: false,
    })
    expect(intent.execution).toEqual({ preferredMode: 'headless' })
    expect(intent.placement).toMatchObject({ agentRoot, cwd: '/repo', runMode: 'task' })
  })

  test('claude-code agent → anthropic + claude-code harness id', () => {
    const { agentRoot, agentId } = makeAgentDir('claude-code')
    const intent = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      cwd: '/repo',
      runMode: 'task',
      interactive: false,
      preferredMode: 'headless',
    })
    expect(intent.harness).toMatchObject({
      provider: 'anthropic',
      id: 'claude-code',
      interactive: false,
    })
  })

  test('caller-supplied interaction semantics pass through; only provider/harness derive', () => {
    const { agentRoot, agentId } = makeAgentDir('codex')
    const intent = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      interactive: false,
      preferredMode: 'nonInteractive',
    })
    expect(intent.execution).toEqual({ preferredMode: 'nonInteractive' })
    expect(intent.harness.interactive).toBe(false)
  })

  test('T-05177: allowInteractiveSurfaceReuse threads into execution only when supplied', () => {
    const { agentRoot, agentId } = makeAgentDir('claude-code')
    const off = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      interactive: false,
      preferredMode: 'headless',
      allowInteractiveSurfaceReuse: false,
    })
    expect(off.execution).toEqual({
      preferredMode: 'headless',
      allowInteractiveSurfaceReuse: false,
    })

    // Omitted ⇒ field absent (HRC treats absence as the default-allow reuse).
    const omitted = buildHrcRuntimeIntent({
      agentId,
      agentRoot,
      interactive: false,
      preferredMode: 'headless',
    })
    expect(omitted.execution).toEqual({ preferredMode: 'headless' })
  })
})
