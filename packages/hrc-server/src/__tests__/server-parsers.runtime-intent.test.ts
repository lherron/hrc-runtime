import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { parseDispatchTurnRequest, parseEnsureRuntimeRequest } from '../server-parsers.js'

function withAgentProfile(harness: string): { agentRoot: string; cleanup: () => void } {
  const agentRoot = mkdtempSync(join(tmpdir(), 'hrc-parser-agent-'))
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2\n\n[identity]\nharness = "${harness}"\n`,
    'utf8'
  )
  return {
    agentRoot,
    cleanup: () => rmSync(agentRoot, { recursive: true, force: true }),
  }
}

describe('server-parsers runtime intent harness resolution', () => {
  it('parseEnsureRuntimeRequest resolves missing harness from placement.agentRoot', () => {
    const { agentRoot, cleanup } = withAgentProfile('codex')
    try {
      const parsed = parseEnsureRuntimeRequest({
        hostSessionId: 'hsid-test',
        intent: {
          placement: {
            agentRoot,
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-project', agentName: 'animata', projectRoot: '/tmp/project' },
          },
          execution: {
            preferredMode: 'headless',
          },
        },
      })

      expect(parsed.intent.harness.provider).toBe('openai')
      expect(parsed.intent.harness.interactive).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('preserves launch and initialPrompt while resolving omitted harness', () => {
    const { agentRoot, cleanup } = withAgentProfile('codex')
    try {
      const parsed = parseEnsureRuntimeRequest({
        hostSessionId: 'hsid-test',
        intent: {
          placement: {
            agentRoot,
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-project', agentName: 'animata', projectRoot: '/tmp/project' },
          },
          execution: {
            preferredMode: 'headless',
          },
          launch: {
            pathPrepend: ['/tmp/fake-codex'],
          },
          initialPrompt: 'Seed a detached session',
        },
      })

      expect(parsed.intent.harness.provider).toBe('openai')
      expect(parsed.intent.launch?.pathPrepend).toEqual(['/tmp/fake-codex'])
      expect(parsed.intent.initialPrompt).toBe('Seed a detached session')
    } finally {
      cleanup()
    }
  })

  it('parseDispatchTurnRequest infers nonInteractive sdk mode when harness is omitted', () => {
    const { agentRoot, cleanup } = withAgentProfile('claude-code')
    try {
      const parsed = parseDispatchTurnRequest({
        hostSessionId: 'hsid-test',
        prompt: 'ship it',
        runtimeIntent: {
          placement: {
            agentRoot,
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-project', agentName: 'animata', projectRoot: '/tmp/project' },
          },
          execution: {
            preferredMode: 'nonInteractive',
          },
        },
      })

      expect(parsed.runtimeIntent).toBeDefined()
      expect(parsed.runtimeIntent?.harness.provider).toBe('anthropic')
      expect(parsed.runtimeIntent?.harness.interactive).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('rejects omitted harness when placement.agentRoot cannot resolve a profile', () => {
    expect(() =>
      parseEnsureRuntimeRequest({
        hostSessionId: 'hsid-test',
        intent: {
          placement: {
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-project', agentName: 'animata', projectRoot: '/tmp/project' },
          },
        },
      })
    ).toThrow('placement.agentRoot')
  })
})
