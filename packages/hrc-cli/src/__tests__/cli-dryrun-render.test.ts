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
    specHash: 'shash',
    startRequestHash: 'rhash',
    selection: {
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-test',
      presentation: true,
      provenance: {
        harness: 'agent-profile',
        modelProvider: 'agent-profile',
        model: 'agent-profile',
        presentation: 'agent-profile',
      },
    },
    execution: {
      recipeId: 'claude-interactive',
      driver: 'claude-code-tmux',
      protocol: 'harness-broker/0.2',
      hosting: {
        executionTransport: 'pty',
        terminalRequired: true,
        terminalHost: 'tmux',
        processExecution: 'broker-process',
      },
      presentationFulfillment: 'intrinsic',
      profile: {
        profileId: 'profile_test',
        profileHash: 'phash',
        compatibilityHash: 'compatibility-hash',
        startRequestHash: 'rhash',
      },
    },
    process: {
      command: 'harness-broker',
      args: ['run', '--append-system-prompt', 'ignored-render-placeholder'],
      cwd: '/tmp/t08596-project',
    },
    initialInput: false,
    inputQueue: 'fifo',
    warnings: [],
    systemPrompt: '# Rex\n\nRex is a test agent.\n',
    systemPromptMode: 'replace',
    promptSectionSizes: ['system=28'],
    reminderSectionSizes: [],
    totalContextChars: 28,
    env: { ASP_AGENT_ROOT: '/tmp/t08596-agents/rex', OTHER: '1' },
    planHash: 'planhash',
    compileId: 'compile-test',
  }
}

function codexPreview(): BrokerRunPreview {
  return {
    ...claudePreview(),
    selection: {
      ...claudePreview().selection,
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-test',
    },
    execution: {
      ...claudePreview().execution,
      recipeId: 'codex-headless',
      driver: 'codex-app-server',
      hosting: {
        executionTransport: 'jsonrpc-stdio',
        terminalRequired: false,
        processExecution: 'broker-process',
      },
      presentationFulfillment: 'attachable',
    },
    process: { command: 'harness-broker', args: ['run', '--transport', 'unix'], cwd: '/tmp/p' },
    systemPromptMode: 'append',
    env: {},
  }
}

function v2Preview(): BrokerRunPreview {
  return {
    ...codexPreview(),
    selection: {
      harness: 'agent-harness',
      modelProvider: 'openai-codex',
      model: 'gpt-5.5',
      presentation: false,
      provenance: {
        harness: 'catalog-default',
        modelProvider: 'agent-profile',
        model: 'project-target',
        presentation: 'summon-directive',
      },
    },
    execution: {
      recipeId: 'agent-harness-headless',
      driver: 'agent-harness',
      protocol: 'harness-broker/0.2',
      hosting: {
        executionTransport: 'native-worker',
        terminalRequired: false,
        processExecution: 'native-worker',
      },
      presentationFulfillment: 'birth-variant',
      profile: {
        profileId: 'v2-profile',
        profileHash: 'v2-profile-hash',
        compatibilityHash: 'v2-compatibility-hash',
        startRequestHash: 'v2-start-request-hash',
      },
    },
    process: { execution: 'native-worker', cwd: '/tmp/v2-native-worker' },
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

  it('renders an execution-release native worker without inventing a command', async () => {
    const preview: BrokerRunPreview = {
      ...codexPreview(),
      process: { execution: 'native-worker', cwd: '/tmp/native-worker' },
    }
    const { chunks, restore } = captureStdout()
    try {
      await renderBrokerPlanPreview(
        (line: string) => void process.stdout.write(`${line}\n`),
        preview,
        undefined
      )
    } finally {
      restore()
    }
    const output = chunks.join('')
    expect(output).toContain('execution:    native-worker')
    expect(output).not.toContain('── command ──')
  })

  it('renders producer selection provenance and the complete v2 execution instead of a profile bridge', async () => {
    const { chunks, restore } = captureStdout()
    try {
      await renderBrokerPlanPreview(
        (line: string) => void process.stdout.write(`${line}\n`),
        v2Preview(),
        undefined
      )
    } finally {
      restore()
    }
    const output = chunks.join('')
    expect(output).toContain('selection.harness: agent-harness (catalog-default)')
    expect(output).toContain('selection.presentation: false (summon-directive)')
    expect(output).toContain('recipe:       agent-harness-headless')
    expect(output).toContain('driver:       agent-harness')
    expect(output).toContain('hosting:      native-worker / native-worker / terminal=no')
    expect(output).toContain('fulfillment:  birth-variant')
    expect(output).toContain('profileId:    v2-profile')
    expect(output).not.toContain('bundle:')
    expect(output).not.toContain('model:        gpt-test')
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
