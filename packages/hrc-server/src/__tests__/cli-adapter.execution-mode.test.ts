import { describe, expect, it } from 'bun:test'

import type {
  BuildProcessInvocationSpecRequest,
  BuildProcessInvocationSpecResponse,
} from 'agent-spaces'
import type { HrcRuntimeIntent } from 'hrc-core'

import { buildCliInvocation } from '../agent-spaces-adapter/cli-adapter'

function makeIntent(
  overrides: Partial<HrcRuntimeIntent> = {},
  placementOverrides: Record<string, unknown> = {}
): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      dryRun: true,
      correlation: {
        hostSessionId: 'hsid-mode-test',
        runId: 'run-mode-test',
        sessionRef: {
          scopeRef: 'agent:rex:project:agent-spaces:task:T-01104',
          laneRef: 'lane:main',
        },
      },
      ...placementOverrides,
    } as HrcRuntimeIntent['placement'],
    harness: {
      provider: 'anthropic',
      interactive: true,
    },
    ...overrides,
  }
}

function makeResponse(): BuildProcessInvocationSpecResponse {
  return {
    spec: {
      argv: ['agent-spaces-cli', '--launch'],
      env: {
        BASE_ENV: 'from-builder',
        PATH: '/usr/bin',
        REMOVE_ME: 'please',
      },
      cwd: '/tmp/materialized',
    },
    warnings: ['warning-from-builder'],
  }
}

describe('buildCliInvocation execution mode mapping', () => {
  it('defaults to interactive + pty and preserves prompt/env plumbing', async () => {
    let capturedRequest: BuildProcessInvocationSpecRequest | undefined

    const result = await buildCliInvocation(
      makeIntent({
        initialPrompt: 'ship it',
        launch: {
          env: { EXTRA_ENV: 'from-launch', BASE_ENV: 'overridden' },
          unsetEnv: ['REMOVE_ME'],
          pathPrepend: ['/custom/bin'],
        },
      }),
      {
        specBuilder: async (req) => {
          capturedRequest = req
          return makeResponse()
        },
      }
    )

    expect(capturedRequest).toBeDefined()
    expect(capturedRequest?.interactionMode).toBe('interactive')
    expect(capturedRequest?.ioMode).toBe('pty')
    expect(capturedRequest?.prompt).toBe('ship it')

    expect(result.argv).toEqual(['agent-spaces-cli', '--launch'])
    expect(result.cwd).toBe('/tmp/materialized')
    expect(result.warnings).toEqual(['warning-from-builder'])
    expect(result.env).toMatchObject({
      BASE_ENV: 'overridden',
      EXTRA_ENV: 'from-launch',
      HRC_HOST_SESSION_ID: 'hsid-mode-test',
      HRC_RUN_ID: 'run-mode-test',
      HRC_SESSION_REF: 'agent:rex:project:agent-spaces:task:T-01104/lane:main',
    })
    expect(result.env.PATH).toBe('/custom/bin:/usr/bin')
    expect(result.env.REMOVE_ME).toBeUndefined()
  })

  it('maps explicit interactive mode to interactive + pty', async () => {
    let capturedRequest: BuildProcessInvocationSpecRequest | undefined

    await buildCliInvocation(makeIntent({ execution: { preferredMode: 'interactive' } }), {
      specBuilder: async (req) => {
        capturedRequest = req
        return makeResponse()
      },
    })

    expect(capturedRequest?.interactionMode).toBe('interactive')
    expect(capturedRequest?.ioMode).toBe('pty')
  })

  it('normalizes anthropic headless mode onto interactive + pty', async () => {
    let capturedRequest: BuildProcessInvocationSpecRequest | undefined

    await buildCliInvocation(makeIntent({ execution: { preferredMode: 'headless' } }), {
      specBuilder: async (req) => {
        capturedRequest = req
        return makeResponse()
      },
    })

    expect(capturedRequest?.interactionMode).toBe('interactive')
    expect(capturedRequest?.ioMode).toBe('pty')
  })

  it('maps openai headless mode to headless + pipes', async () => {
    let capturedRequest: BuildProcessInvocationSpecRequest | undefined

    await buildCliInvocation(
      makeIntent(
        {
          harness: {
            provider: 'openai',
            interactive: true,
          },
          execution: { preferredMode: 'headless' },
        },
        {}
      ),
      {
        specBuilder: async (req) => {
          capturedRequest = req
          return makeResponse()
        },
      }
    )

    expect(capturedRequest?.interactionMode).toBe('headless')
    expect(capturedRequest?.ioMode).toBe('pipes')
  })

  it('normalizes openai nonInteractive mode onto headless + pipes for agent-spaces', async () => {
    let capturedRequest: BuildProcessInvocationSpecRequest | undefined

    await buildCliInvocation(
      makeIntent(
        {
          harness: {
            provider: 'openai',
            interactive: true,
          },
          execution: { preferredMode: 'nonInteractive' },
        },
        {}
      ),
      {
        specBuilder: async (req) => {
          capturedRequest = req
          return makeResponse()
        },
      }
    )

    expect(capturedRequest?.interactionMode).toBe('headless')
    expect(capturedRequest?.ioMode).toBe('pipes')
  })

  it('suppresses the stored initial prompt when attach resume asks to skip priming', async () => {
    let capturedRequest: BuildProcessInvocationSpecRequest | undefined

    const result = await buildCliInvocation(
      makeIntent(
        {
          harness: {
            provider: 'openai',
            interactive: true,
          },
          initialPrompt: 'Seed before attach',
        },
        {}
      ),
      {
        continuation: { provider: 'openai', key: 'thread-123' },
        suppressInitialPrompt: true,
        specBuilder: async (req) => {
          capturedRequest = req
          return {
            spec: {
              argv: req.prompt
                ? ['codex', 'resume', 'thread-123', req.prompt]
                : ['codex', 'resume', 'thread-123'],
              env: {
                PATH: '/usr/bin',
              },
              cwd: '/tmp/materialized',
            },
          }
        },
      }
    )

    expect(capturedRequest?.prompt).toBe('')
    expect(result.argv).toEqual(['codex', 'resume', 'thread-123'])
    expect(result.argv).not.toContain('Seed before attach')
  })
})
