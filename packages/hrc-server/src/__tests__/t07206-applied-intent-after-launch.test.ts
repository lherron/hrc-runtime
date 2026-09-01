import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'

import { AspcFacadeBrokerClient } from '../agent-spaces-adapter/aspc-facade-client'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE = 'agent:t07206:project:hrc-runtime:task:T-07206'

const PRIOR_INTENT: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/prior-agent',
    projectRoot: '/tmp/prior-project',
    cwd: '/tmp/prior-project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { provider: 'openai', id: 'codex-cli', interactive: false },
  launch: { env: { T07206_AUTHORITY: 'prior' } },
}

function candidateIntent(interactive: boolean): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/rejected-agent',
      projectRoot: '/tmp/rejected-project',
      cwd: '/tmp/rejected-project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: interactive
      ? { provider: 'anthropic', id: 'claude-code', interactive: true }
      : { provider: 'openai', id: 'codex-cli', interactive: false },
    execution: { preferredMode: interactive ? 'interactive' : 'headless' },
    launch: { env: { T07206_AUTHORITY: 'rejected' } },
  }
}

function installRejectingFacade(): ReturnType<typeof spyOn> {
  return spyOn(AspcFacadeBrokerClient, 'start').mockImplementation(async () => {
    return {
      hello: async () => ({
        protocolVersion: ASPC_PROTOCOL_VERSION,
        facadeInfo: { name: 'aspc-facade', version: 't07206-test' },
        capabilities: { compileHarnessInvocation: true, cohostedBroker: true },
      }),
      compileHarnessInvocation: async () => ({
        schemaVersion: 'aspc-compile-harness-invocation-response/v1',
        ok: false,
        diagnostics: [],
      }),
      close: async () => undefined,
    } as unknown as AspcFacadeBrokerClient
  })
}

let fixture: HrcServerTestFixture
let server: HrcServer
let facadeSpy: ReturnType<typeof spyOn>

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07206-applied-intent-')
  server = await createHrcServer(
    fixture.serverOpts({
      headlessCodexBrokerEnabled: true,
      claudeCodeTmuxBrokerEnabled: true,
      otelListenerEnabled: false,
    })
  )
  facadeSpy = installRejectingFacade()
})

afterEach(async () => {
  facadeSpy.mockRestore()
  await server.stop()
  await fixture.cleanup()
})

async function seededSession() {
  const resolved = await fixture.resolveSession(SCOPE)
  const db = (server as unknown as { db: HrcDatabase }).db
  db.sessions.updateIntent(resolved.hostSessionId, PRIOR_INTENT, fixture.now())
  const session = db.sessions.getByHostSessionId(resolved.hostSessionId)
  if (session === null) throw new Error('T-07206 fixture session was not persisted')
  return { db, session }
}

describe('T-07206 applied intent authority', () => {
  it('keeps prior authority through the public headless start API', async () => {
    const { db, session } = await seededSession()

    const response = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: session.hostSessionId,
      intent: candidateIntent(false),
      restartStyle: 'reuse_pty',
    })

    expect(response.status).toBe(503)
    expect(db.sessions.getByHostSessionId(session.hostSessionId)?.lastAppliedIntentJson).toEqual(
      PRIOR_INTENT
    )
  })

  it('keeps prior authority through the public interactive ensure API', async () => {
    const { db, session } = await seededSession()

    const response = await fixture.postJson('/v1/runtimes/ensure', {
      hostSessionId: session.hostSessionId,
      intent: candidateIntent(true),
      restartStyle: 'reuse_pty',
    })

    expect(response.status).toBe(503)
    expect(db.sessions.getByHostSessionId(session.hostSessionId)?.lastAppliedIntentJson).toEqual(
      PRIOR_INTENT
    )
  })

  it('keeps the prior applied intent when headless compile admission rejects', async () => {
    const { db, session } = await seededSession()

    await expect(
      (
        server as unknown as {
          startHeadlessBrokerRuntime(
            session: typeof session,
            intent: HrcRuntimeIntent,
            prompt: string,
            runId: string
          ): Promise<unknown>
        }
      ).startHeadlessBrokerRuntime(
        session,
        candidateIntent(false),
        'rejected headless turn',
        'run-t07206-headless'
      )
    ).rejects.toThrow('headless broker compile/admission rejected')

    expect(db.sessions.getByHostSessionId(session.hostSessionId)?.lastAppliedIntentJson).toEqual(
      PRIOR_INTENT
    )

    // The queued-drain consumer re-reads persisted authority after the failed
    // start. Prove that it dispatches with the prior materialized intent rather
    // than the rejected candidate.
    const queuedAt = fixture.now()
    db.runs.insert({
      runId: 'run-t07206-queued',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      status: 'queued',
      acceptedAt: queuedAt,
      updatedAt: queuedAt,
      queuedInputSeq: 1,
    })
    db.runs.setCorrelationJson(
      'run-t07206-queued',
      JSON.stringify({ kind: 'queued_turn', source: 'test', prompt: 'automatic follow-up' })
    )
    let drainedIntent: HrcRuntimeIntent | undefined
    ;(server as unknown as Record<string, unknown>)['dispatchTurnForSession'] = async (
      _session: unknown,
      intent: HrcRuntimeIntent
    ) => {
      drainedIntent = intent
      return Response.json({
        status: 'started',
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: 'rt-t07206-prior',
        runId: 'run-t07206-queued',
      })
    }
    await (
      server as unknown as { drainDurableHeadlessTurnInputs(hostSessionId: string): Promise<void> }
    ).drainDurableHeadlessTurnInputs(session.hostSessionId)
    expect(drainedIntent).toEqual(PRIOR_INTENT)
  })

  it('keeps the prior applied intent when interactive compile admission rejects', async () => {
    const { db, session } = await seededSession()

    await expect(
      (
        server as unknown as {
          startInteractiveTmuxBrokerRuntime(
            session: typeof session,
            intent: HrcRuntimeIntent,
            runId: string,
            options: {
              flagEnvName: string
              allowedBrokerDriver: 'claude-code-tmux'
            }
          ): Promise<unknown>
        }
      ).startInteractiveTmuxBrokerRuntime(
        session,
        candidateIntent(true),
        'run-t07206-interactive',
        {
          flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED',
          allowedBrokerDriver: 'claude-code-tmux',
        }
      )
    ).rejects.toThrow('interactive broker compile/admission rejected')

    expect(db.sessions.getByHostSessionId(session.hostSessionId)?.lastAppliedIntentJson).toEqual(
      PRIOR_INTENT
    )
  })

  it('does not pre-authorize a cold mail-kicker birth before launch succeeds', async () => {
    const db = (server as unknown as { db: HrcDatabase }).db
    const intent = candidateIntent(false)
    const coldScope = `${SCOPE}/lane:mail-cold`
    const session = await (
      server as unknown as {
        ensureTargetSession(
          sessionRef: string,
          intent: HrcRuntimeIntent,
          parsedScopeJson: undefined,
          origin: 'local',
          options: { persistIntent: false }
        ): Promise<Awaited<ReturnType<typeof seededSession>>['session']>
      }
    ).ensureTargetSession(coldScope, intent, undefined, 'local', {
      persistIntent: false,
    })

    expect(
      db.sessions.getByHostSessionId(session.hostSessionId)?.lastAppliedIntentJson
    ).toBeUndefined()

    await expect(
      (
        server as unknown as {
          startHeadlessBrokerRuntime(
            session: typeof session,
            intent: HrcRuntimeIntent,
            prompt: string,
            runId: string
          ): Promise<unknown>
        }
      ).startHeadlessBrokerRuntime(session, intent, 'rejected mail drive', 'run-t07206-mail-cold')
    ).rejects.toThrow('headless broker compile/admission rejected')

    expect(
      db.sessions.getByHostSessionId(session.hostSessionId)?.lastAppliedIntentJson
    ).toBeUndefined()
  })
})
