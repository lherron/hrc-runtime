import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot } from 'hrc-core'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:t07920:project:hrc-runtime:task:T-07920'
const KICK = 'Message Type: MESSAGE\nTask name: T-07920\nImplement the requested change.'

const INTENT: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/t07920-agent',
    projectRoot: '/tmp/t07920-project',
    cwd: '/tmp/t07920-project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
  execution: { preferredMode: 'interactive' },
}

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07920-launch-prompt-')
  server = await createHrcServer(
    fixture.serverOpts({
      claudeCodeTmuxBrokerEnabled: true,
      brokerDurableIpcEnabled: false,
      otelListenerEnabled: false,
    })
  )
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

describe('T-07920 launch-primed cold summons', () => {
  it('refuses the kick-primed cold summons with aspd_unconfigured and persists no authority', async () => {
    // T-08596: the local facade compile behind a launch-primed cold summons
    // is deleted. On a node that declares no aspd endpoint the summons refuses
    // with the typed closure refusal before any compile is consulted.
    const resolved = await fixture.resolveSession(SCOPE)
    const internal = server as unknown as {
      db: {
        sessions: {
          getByHostSessionId(
            hostSessionId: string
          ): Awaited<ReturnType<HrcServerTestFixture['resolveSession']>> | null
        }
      }
      startInteractiveTmuxBrokerRuntime(
        session: NonNullable<ReturnType<typeof internal.db.sessions.getByHostSessionId>>,
        intent: HrcRuntimeIntent,
        runId: string,
        options: {
          flagEnvName: string
          allowedBrokerDriver: 'claude-code-tmux'
          coldBirthPrompt: string
          onColdBirthPromptRoute(rodeLaunch: boolean): void
        }
      ): Promise<HrcRuntimeSnapshot>
    }
    const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
    if (session === null) throw new Error('T-07920 fixture session was not persisted')

    const error = await internal
      .startInteractiveTmuxBrokerRuntime(session, INTENT, 'run-t07920', {
        flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
        allowedBrokerDriver: 'claude-code-tmux',
        coldBirthPrompt: KICK,
        onColdBirthPromptRoute: () => {
          throw new Error('no launch route may be taken on refusal')
        },
      })
      .then(
        () => {
          throw new Error('cold summons without an aspd endpoint must refuse')
        },
        (refusal: unknown) => refusal as Error & { detail?: Record<string, unknown> }
      )
    expect(String(error.message)).toContain('aspd-independent execution closure')
    expect(error.detail).toMatchObject({
      code: 'aspd_unconfigured',
      site: 'interactive-broker-birth',
    })
    // The refused summons must not become reusable session authority.
    const persisted = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
    expect(persisted?.lastAppliedIntentJson?.initialPrompt).toBeUndefined()
  })
})
