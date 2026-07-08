import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { HrcErrorCode, HrcUnprocessableEntityError } from 'hrc-core'

import { parseSemanticDmRequest } from '../messages.js'
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

  it('parseDispatchTurnRequest preserves waitForCompletion for detached dispatch', () => {
    const parsed = parseDispatchTurnRequest({
      hostSessionId: 'hsid-test',
      prompt: 'ship it',
      waitForCompletion: false,
    })

    expect(parsed.waitForCompletion).toBe(false)
  })

  it('parseDispatchTurnRequest rejects unsupported whenBusy with a 422-native domain error', () => {
    let thrown: unknown
    try {
      parseDispatchTurnRequest({
        hostSessionId: 'hsid-test',
        prompt: 'ship it',
        whenBusy: 'queue',
      })
    } catch (error) {
      thrown = error
    }

    // T-05097: this branch must throw a real 422 error class/code, not
    // HrcBadRequestError with status patched after construction.
    expect(thrown).toBeInstanceOf(HrcUnprocessableEntityError)
    expect(thrown).toMatchObject({
      name: 'HrcUnprocessableEntityError',
      status: 422,
      code: (HrcErrorCode as Record<string, string>).UNSUPPORTED_WHEN_BUSY,
      message: 'whenBusy must be "reject"',
      detail: { field: 'whenBusy', value: 'queue' },
    })
  })

  it('parseDispatchTurnRequest accepts json_schema responseFormat', () => {
    const parsed = parseDispatchTurnRequest({
      hostSessionId: 'hsid-test',
      prompt: 'ship it',
      responseFormat: {
        kind: 'json_schema',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
    })

    expect(parsed.responseFormat).toEqual({
      kind: 'json_schema',
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
    })
  })

  it('parseDispatchTurnRequest accepts text responseFormat as a no-op value', () => {
    const parsed = parseDispatchTurnRequest({
      hostSessionId: 'hsid-test',
      prompt: 'ship it',
      responseFormat: { kind: 'text' },
    })

    expect(parsed.responseFormat).toEqual({ kind: 'text' })
  })

  it.each([
    ['primitive responseFormat', 42],
    ['array responseFormat', []],
    ['missing kind', {}],
    ['unsupported kind', { kind: 'xml' }],
    ['text with schema', { kind: 'text', schema: {} }],
    ['missing json schema', { kind: 'json_schema' }],
    ['array json schema', { kind: 'json_schema', schema: [] }],
    ['undefined schema value', { kind: 'json_schema', schema: { bad: undefined } }],
    ['non-finite schema value', { kind: 'json_schema', schema: { bad: Number.NaN } }],
  ])('parseDispatchTurnRequest rejects malformed responseFormat: %s', (_name, responseFormat) => {
    expect(() =>
      parseDispatchTurnRequest({
        hostSessionId: 'hsid-test',
        prompt: 'ship it',
        responseFormat,
      })
    ).toThrow('responseFormat')
  })

  it('parseSemanticDmRequest accepts responseFormat for session turn dispatch', () => {
    const parsed = parseSemanticDmRequest({
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:cody:project:hrc-runtime/lane:main' },
      body: 'ship it',
      responseFormat: {
        kind: 'json_schema',
        schema: { type: 'object', properties: { done: { type: 'boolean' } } },
      },
    })

    expect(parsed.responseFormat).toEqual({
      kind: 'json_schema',
      schema: { type: 'object', properties: { done: { type: 'boolean' } } },
    })
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
