import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'

import * as hrc from '../index.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:e2e-t08338-routing'

type Harness = HrcRuntimeIntent['harness']

const intent = (harness: Harness): HrcRuntimeIntent => ({
  placement: { kind: 'inline' } as unknown as HrcRuntimeIntent['placement'],
  harness,
  execution: { preferredMode: 'nonInteractive' },
})

const api = hrc as unknown as {
  shouldRedirectCodexToInteractiveBroker: (intent: HrcRuntimeIntent) => boolean
  normalizeCodexInteractiveBrokerIntent: (intent: HrcRuntimeIntent) => HrcRuntimeIntent
  shouldConsiderCodexCliTmuxBrokerDispatch: (intent: HrcRuntimeIntent) => boolean
  shouldUseHeadlessTransport: (intent: HrcRuntimeIntent) => boolean
}

describe('T-08338 Codex redirect seam', () => {
  it('admits the measured codex-cli shape and the downstream-compatible id-less shape', () => {
    for (const harness of [
      { provider: 'openai', interactive: false, id: 'codex-cli' },
      { provider: 'openai', interactive: false },
    ] satisfies Harness[]) {
      expect(api.shouldRedirectCodexToInteractiveBroker(intent(harness))).toBe(true)
    }
  })

  it('does not swallow neighboring OpenAI harnesses whose id is the route fence', () => {
    for (const id of ['pi-sdk', 'pi-cli', 'agent-sdk'] as const) {
      expect(
        api.shouldRedirectCodexToInteractiveBroker(
          intent({ provider: 'openai', interactive: false, id })
        )
      ).toBe(false)
    }
  })

  it('does not widen the Claude redirect', () => {
    expect(
      api.shouldRedirectCodexToInteractiveBroker(
        intent({ provider: 'anthropic', interactive: false, id: 'claude-code' })
      )
    ).toBe(false)
  })

  it('normalizes to the interactive codex-app-server route', () => {
    const normalized = api.normalizeCodexInteractiveBrokerIntent(
      intent({ provider: 'openai', interactive: false, id: 'codex-cli' })
    )

    expect(normalized.harness).toEqual({
      provider: 'openai',
      interactive: true,
      id: 'codex-cli',
    })
    expect(normalized.execution?.preferredMode).toBe('interactive')
    expect(api.shouldUseHeadlessTransport(normalized)).toBe(false)
    expect(api.shouldConsiderCodexCliTmuxBrokerDispatch(normalized)).toBe(true)
  })
})

describe('T-08338 cold dispatch routing', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t08338-codex-redirect-')
    server = await createHrcServer(
      fixture.serverOpts({
        headlessCodexBrokerEnabled: true,
        codexCliTmuxBrokerEnabled: true,
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

  it('redirects ordinary cold Codex dispatch but leaves schema-bearing cold dispatch headless', async () => {
    const resolved = await fixture.resolveSession(SCOPE)
    const internal = server as unknown as HrcServerInstanceForHandlers
    const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
    if (session === null) throw new Error('T-08338 fixture session missing')

    const routes: Array<{ route: 'interactive' | 'headless'; intent: HrcRuntimeIntent }> = []
    internal.handleInteractiveTmuxBrokerDispatchTurn = async (
      routedSession,
      routedIntent,
      _prompt,
      runId
    ) => {
      routes.push({ route: 'interactive', intent: routedIntent })
      return Response.json({
        runId,
        hostSessionId: routedSession.hostSessionId,
        generation: routedSession.generation,
        runtimeId: 'rt-t08338-interactive',
        transport: 'tmux',
        status: 'started',
        supportsInFlightInput: true,
      })
    }
    internal.handleHeadlessBrokerDispatchTurn = async (
      routedSession,
      routedIntent,
      _prompt,
      runId
    ) => {
      routes.push({ route: 'headless', intent: routedIntent })
      return Response.json({
        runId,
        hostSessionId: routedSession.hostSessionId,
        generation: routedSession.generation,
        runtimeId: 'rt-t08338-headless',
        transport: 'headless',
        status: 'started',
        supportsInFlightInput: true,
      })
    }

    const codexIntent = intent({ provider: 'openai', interactive: false, id: 'codex-cli' })
    await internal.dispatchTurnForSession(session, codexIntent, 'ordinary', {
      waitForCompletion: false,
    })
    await internal.dispatchTurnForSession(session, codexIntent, 'structured', {
      waitForCompletion: false,
      responseFormat: {
        kind: 'json_schema',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    })

    expect(routes.map(({ route }) => route)).toEqual(['interactive', 'headless'])
    expect(routes[0]?.intent.harness.interactive).toBe(true)
    expect(routes[0]?.intent.execution?.preferredMode).toBe('interactive')
    expect(routes[1]?.intent.harness.interactive).toBe(false)
    expect(routes[1]?.intent.execution?.preferredMode).toBe('nonInteractive')
  })
})
