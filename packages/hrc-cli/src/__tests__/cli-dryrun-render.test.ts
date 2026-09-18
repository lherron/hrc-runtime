/**
 * T-08596 (T-08569A closure) — the CLI renders the daemon-compiled preview
 * document. These tests feed canned `BrokerRunPreview` documents (the exact
 * shape `POST /v1/previews/run` returns) through the render branch and pin
 * every plan line plus the framed prompts. Live daemon compilation is proved
 * on the scratch daemon (evidence/dryrun-daemon-preview.txt); the fixture
 * servers in cli-start.test.ts declare no aspd endpoint and pin the refusal
 * branch instead.
 */
import { describe, expect, it } from 'bun:test'

import type { BrokerRunPreview } from 'hrc-core'

import { renderBrokerPlanPreview } from '../cli/handlers-scope-cmd'

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  const restore = (): void => {
    process.stdout.write = originalWrite
  }
  return { chunks, restore }
}

function claudePreview(): BrokerRunPreview {
  return {
    controllerKind: 'harness-broker',
    brokerDriver: 'claude-code-tmux',
    interactionMode: 'interactive',
    profileId: 'profile_test',
    profileHash: 'phash',
    specHash: 'shash',
    startRequestHash: 'rhash',
    process: {
      command: 'harness-broker',
      args: ['run', '--append-system-prompt', 'ignored-render-placeholder'],
      cwd: '/tmp/t08596-project',
    },
    initialInput: false,
    inputQueue: 'fifo',
    interrupt: 'signal',
    warnings: [],
    systemPrompt: '# Rex\n\nRex is a test agent.\n',
    systemPromptMode: 'replace',
    promptSectionSizes: ['system=28'],
    reminderSectionSizes: [],
    totalContextChars: 28,
    env: { ASP_AGENT_ROOT: '/tmp/t08596-agents/rex', OTHER: '1' },
    planHash: 'planhash',
    compileId: 'compile-test',
    bundleIdentity: 'bundle:test',
    model: { provider: 'anthropic', modelId: 'claude-test' },
  }
}

function codexPreview(): BrokerRunPreview {
  return {
    ...claudePreview(),
    brokerDriver: 'codex-app-server',
    interactionMode: 'headless',
    process: { command: 'harness-broker', args: ['run', '--transport', 'unix'], cwd: '/tmp/p' },
    systemPromptMode: 'append',
    model: { provider: 'openai', modelId: 'gpt-test' },
    env: {},
  }
}

describe('hrc dry-run daemon preview rendering (T-08596)', () => {
  it('frames the compiled system prompt alongside the full broker plan', async () => {
    const { chunks, restore } = captureStdout()
    try {
      const rendered = await renderBrokerPlanPreview(
        (line: string) => void process.stdout.write(`${line}\n`),
        claudePreview(),
        undefined
      )
      expect(rendered).toBe(true)
    } finally {
      restore()
    }
    const output = chunks.join('')
    expect(output).toContain('System Prompt (replace)')
    expect(output).toContain('Rex is a test agent.')
    expect(output).toContain('── env ──')
    expect(output).toContain('ASP_AGENT_ROOT')
    expect(output).toContain('── command ──')
    expect(output).toContain('brokerPlan:   available')
    expect(output).toContain('controller:   harness-broker')
    expect(output).toContain('driver:       claude-code-tmux')
    expect(output).toContain('specHash:     shash')
    expect(output).toContain('requestHash:  rhash')
    expect(output).toContain('inputQueue:   fifo')
  })

  it('renders the priming prompt supplied on the command line', async () => {
    const preview = { ...claudePreview(), primingPrompt: 'probe the thing' }
    const { chunks, restore } = captureStdout()
    try {
      await renderBrokerPlanPreview(
        (line: string) => void process.stdout.write(`${line}\n`),
        preview,
        'probe the thing!'
      )
    } finally {
      restore()
    }
    const output = chunks.join('')
    expect(output).toContain('Priming Prompt')
    expect(output).toContain('probe the thing')
    expect(output).toContain('initialPrompt: 16 chars')
  })

  it('renders the system prompt for a codex-route preview, which carries no prompt argv', async () => {
    const { chunks, restore } = captureStdout()
    try {
      await renderBrokerPlanPreview(
        (line: string) => void process.stdout.write(`${line}\n`),
        codexPreview(),
        undefined
      )
    } finally {
      restore()
    }
    const output = chunks.join('')
    expect(output).toContain('driver:       codex-app-server')
    expect(output).toContain('brokerPlan:   available')
    expect(output).not.toContain('--append-system-prompt')
    expect(output).not.toContain('promptFile:')
    expect(output).toMatch(/System Prompt \((append|replace)\)/)
    expect(output).toContain('Rex is a test agent.')
  })
})
