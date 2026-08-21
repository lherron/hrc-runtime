import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import type { HrcServer } from '../index.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const ALLOWED = ['room-coordinator', 'two-box-implementer', 'daedalus'] as const
const OUTSIDE_SCOPE = 'agent:mable:project:agent-loop:task:primary'
const OUTSIDE_SESSION = `${OUTSIDE_SCOPE}/lane:main`

function runtimeIntent() {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', interactive: false },
    execution: { preferredMode: 'headless' },
  }
}

async function errorFrom(response: Response): Promise<{
  code?: string
  message?: string
  detail?: Record<string, unknown>
}> {
  const body = (await response.json()) as {
    error?: { code?: string; message?: string; detail?: Record<string, unknown> }
  }
  return body.error ?? {}
}

describe('T-06875 container-local persona allowlist', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t06875-persona-')
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  test('omitting the allowlist preserves unrestricted session birth', async () => {
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))

    const response = await fixture.postJson('/v1/sessions/resolve', {
      sessionRef: OUTSIDE_SESSION,
      create: true,
      summonIntent: 'explicit_local',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ created: true })
  })

  test('every allowlisted persona resolves and launches a configured local runtime', async () => {
    server = await createHrcServer(
      fixture.serverOpts({
        otelListenerEnabled: false,
        localPersonaAllowlist: ALLOWED,
      })
    )

    for (const [index, agentId] of ALLOWED.entries()) {
      const sessionRef = `agent:${agentId}/project:hrc-runtime/task:T-06875/lane:allowed-${index}`
      const response = await fixture.postJson('/v1/command-runs/launch', {
        configuredTargetId: 'test-command-run-success',
        sessionRef,
        idempotencyKey: `t06875-${agentId}`,
        binding: {
          WRKF_TASK_ID: 'T-06875',
          WRKF_ACTION_RUN_ID: `action-run-${agentId}`,
          WRKF_RUN_ID: `wrkf-run-${agentId}`,
          WRKF_ACTION: 'validate',
          WRKF_ROLE: agentId,
          ASP_PROJECT: 'hrc-runtime',
          HRC_SESSION_REF: sessionRef,
          HRC_LANE: `allowed-${index}`,
        },
        stdinJson: { expectedExit: 0 },
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        hostSessionId: expect.stringMatching(/^hsid-/),
        runtimeId: expect.stringMatching(/^rt-/),
        transport: 'tmux',
      })
    }

    const db = (
      server as HrcServer & {
        db: {
          sessions: { count(): number }
          runtimes: { listAll(): unknown[] }
          runs: { listRuns(filter: Record<string, unknown>): Array<{ status: string }> }
        }
      }
    ).db
    const deadline = Date.now() + 2_000
    while (
      Date.now() < deadline &&
      db.runs.listRuns({}).some((run) => run.status !== 'completed')
    ) {
      await Bun.sleep(10)
    }
    expect(db.runs.listRuns({}).every((run) => run.status === 'completed')).toBe(true)
    expect(db.sessions.count()).toBe(ALLOWED.length)
    expect(db.runtimes.listAll()).toHaveLength(ALLOWED.length)
  })

  test('direct local DM, turn handoff, and runtime start reject a pre-existing outside scope', async () => {
    fixture.seedSession('hsid-t06875-outside', OUTSIDE_SCOPE)
    server = await createHrcServer(
      fixture.serverOpts({
        otelListenerEnabled: false,
        localPersonaAllowlist: ALLOWED,
      })
    )

    const requests = [
      fixture.postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: OUTSIDE_SESSION },
        body: 'must not deliver',
      }),
      fixture.postJson('/v1/messages/turn-handoff', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: OUTSIDE_SESSION },
        body: 'must not hand off',
      }),
      fixture.postJson('/v1/runtimes/start', {
        hostSessionId: 'hsid-t06875-outside',
        intent: runtimeIntent(),
      }),
    ]

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(409)
      const error = await errorFrom(response)
      expect(error.code).toBe('stale_context')
      expect(error.message).toContain('agent "mable"')
      expect(error.message).toContain(OUTSIDE_SCOPE)
      expect(error.detail).toMatchObject({
        agentId: 'mable',
        scopeRef: OUTSIDE_SCOPE,
        reason: 'local-persona-not-allowed',
      })
    }

    const db = (
      server as HrcServer & {
        db: {
          messages: { query(filter: Record<string, unknown>): unknown[] }
          runtimes: { listAll(): unknown[] }
        }
      }
    ).db
    expect(db.messages.query({})).toHaveLength(0)
    expect(db.runtimes.listAll()).toHaveLength(0)
  })

  test('claim-birth is refused before consulting task authority or minting a session', async () => {
    await writeFile(
      `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({ nodeId: 'room-test', gate: { mode: 'enforce' } }),
      { mode: 0o600 }
    )
    server = await createHrcServer(
      fixture.serverOpts({
        otelListenerEnabled: false,
        localPersonaAllowlist: ALLOWED,
      })
    )
    const claimCalls: string[] = []
    Object.assign(server, {
      policyFor: async () => ({
        provisioning: { node: 'room-test' },
        placement: { pins: {}, homes: {} },
        claimsTask: true,
      }),
      capabilityFor: async () => ({ outcome: 'capable' }),
      taskClaimClient: {
        async claim() {
          claimCalls.push('claim')
          throw new Error('claim must not be reached')
        },
        async release() {
          claimCalls.push('release')
        },
      },
    })

    const response = await fixture.postJson('/v1/sessions/resolve', {
      sessionRef: OUTSIDE_SESSION,
      create: true,
      summonIntent: 'explicit_local',
    })

    expect(response.status).toBe(409)
    expect((await errorFrom(response)).detail).toMatchObject({
      agentId: 'mable',
      scopeRef: OUTSIDE_SCOPE,
      reason: 'local-persona-not-allowed',
    })
    expect(claimCalls).toEqual([])
    const db = (server as HrcServer & { db: { sessions: { count(): number } } }).db
    expect(db.sessions.count()).toBe(0)
  })
})
