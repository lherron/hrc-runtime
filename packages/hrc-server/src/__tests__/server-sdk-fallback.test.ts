import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { type HrcServer, createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

async function resolveSession(scope: string): Promise<string> {
  const resolved = await fixture.resolveSession(scope)
  return resolved.hostSessionId
}

describe('SDK fallback transport selection', () => {
  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-sdk-fallback-')
    server = await createHrcServer(fixture.serverOpts())
  })

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = undefined
    }
    await fixture.cleanup()
  })

  it('does not fall back to SDK when the latest tmux runtime is busy', async () => {
    const scope = 'sdk-fallback-busy-tmux'
    const hsid = await resolveSession(scope)
    fixture.seedTmuxRuntime(hsid, scope, 'rt-busy-tmux', {
      status: 'busy',
      activeRunId: 'run-existing',
    })

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Fallback test — tmux busy should use SDK',
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: {
          provider: 'anthropic',
          interactive: false,
        },
        execution: {
          preferredMode: 'nonInteractive',
        },
      },
    })

    const data = (await res.json()) as any
    expect(res.status).toBe(422)
    expect(data.error?.code).toBe('missing_runtime_intent')
  })

  it('does not fall back to SDK when the latest tmux runtime is starting', async () => {
    const scope = 'sdk-fallback-starting-tmux'
    const hsid = await resolveSession(scope)
    fixture.seedTmuxRuntime(hsid, scope, 'rt-starting-tmux', {
      status: 'starting',
      activeRunId: 'run-existing',
      launchId: 'launch-existing',
    })

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Fallback test — tmux starting should use SDK',
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: {
          provider: 'anthropic',
          interactive: false,
        },
        execution: {
          preferredMode: 'nonInteractive',
        },
      },
    })

    const data = (await res.json()) as any
    expect(res.status).toBe(422)
    expect(data.error?.code).toBe('missing_runtime_intent')
  })
})
