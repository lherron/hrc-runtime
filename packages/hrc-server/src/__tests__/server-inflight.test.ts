/**
 * RED/GREEN tests for hrc-server Phase 3 — Semantic In-Flight Input (T-00969)
 *
 * Tests the server's POST /v1/in-flight-input endpoint:
 *   - Unknown runtimeId -> 404 unknown_runtime
 *   - Tmux runtime -> 422 inflight_unsupported
 *   - Retired SDK runtime -> 422 inflight_unsupported
 *   - inflight.rejected event emitted on rejection
 *
 * Pass conditions for Larry (T-00969):
 *   1. POST /v1/in-flight-input with unknown runtimeId returns 404
 *      { error: { code: 'unknown_runtime' } }
 *   2. POST /v1/in-flight-input on a tmux-transport runtime returns 422
 *      { error: { code: 'inflight_unsupported' } }
 *   3. POST /v1/in-flight-input on a retired SDK runtime
 *      returns 422 { error: { code: 'inflight_unsupported' } }
 *   4. On rejection, an event with
 *      eventKind='inflight.rejected' is appended with the rejection reason
 *
 * Reference: wrkq T-00946 (agent-spaces/hrc/implementation-plan, archived).
 * The plan document itself no longer exists; docs/hrc-server-architecture.md
 * describes the shipped architecture.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

/** Resolve a session and return the hostSessionId */
async function resolveSession(scope: string): Promise<string> {
  const resolved = await fixture.resolveSession(scope)
  return resolved.hostSessionId
}

function seedSdkActiveRuntime(input: {
  hostSessionId: string
  scopeRef: string
  runtimeId: string
  runId: string
  supportsInflightInput?: boolean | undefined
  provider?: 'anthropic' | 'openai' | undefined
}): void {
  const db = openHrcDatabase(fixture.dbPath)
  const timestamp = fixture.now()
  try {
    db.sessions.insert({
      hostSessionId: input.hostSessionId,
      scopeRef: input.scopeRef,
      laneRef: 'default',
      generation: 1,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: input.runtimeId,
      hostSessionId: input.hostSessionId,
      scopeRef: input.scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'sdk',
      harness: 'agent-sdk',
      provider: input.provider ?? 'anthropic',
      status: 'busy',
      supportsInflightInput: input.supportsInflightInput ?? true,
      adopted: false,
      activeRunId: input.runId,
      lastActivityAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    db.runs.insert({
      runId: input.runId,
      hostSessionId: input.hostSessionId,
      runtimeId: input.runtimeId,
      scopeRef: input.scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'sdk',
      status: 'running',
      acceptedAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
    })
  } finally {
    db.close()
  }
}

function seedTmuxRuntime(hostSessionId: string, runtimeId: string): void {
  const db = openHrcDatabase(fixture.dbPath)
  const timestamp = fixture.now()
  try {
    const session = db.sessions.getByHostSessionId(hostSessionId)
    if (!session) {
      throw new Error(`missing session ${hostSessionId}`)
    }
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      tmuxJson: {
        socketPath: fixture.tmuxSocketPath,
        sessionName: 'hrc-test-legacy',
        windowName: 'main',
        sessionId: '$legacy',
        windowId: '@legacy',
        paneId: '%legacy',
      },
      supportsInflightInput: false,
      adopted: false,
      lastActivityAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-inflight-test-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

// ---------------------------------------------------------------------------
// 2. Unknown runtimeId -> 404
// ---------------------------------------------------------------------------
describe('POST /v1/in-flight-input — unknown runtime', () => {
  it('returns 404 with code unknown_runtime for nonexistent runtimeId', async () => {
    const res = await fixture.postJson('/v1/in-flight-input', {
      runtimeId: 'rt-does-not-exist',
      runId: 'run-doesnt-matter',
      prompt: 'Input for missing runtime',
    })

    expect(res.status).toBe(404)
    const data = (await res.json()) as any
    expect(data.error).toBeDefined()
    expect(data.error.code).toBe('unknown_runtime')
  })
})

// ---------------------------------------------------------------------------
// 4. Tmux runtime -> 422 inflight_unsupported
// ---------------------------------------------------------------------------
describe('POST /v1/in-flight-input — tmux runtime unsupported', () => {
  it('returns 422 with code inflight_unsupported for tmux transport runtime', async () => {
    const hsid = await resolveSession('inflight-tmux-1')

    const tmuxRuntimeId = `rt-tmux-${randomUUID()}`
    seedTmuxRuntime(hsid, tmuxRuntimeId)

    const res = await fixture.postJson('/v1/in-flight-input', {
      runtimeId: tmuxRuntimeId,
      runId: 'run-doesnt-matter',
      prompt: 'Input to tmux runtime',
    })

    expect(res.status).toBe(422)
    const data = (await res.json()) as any
    expect(data.error).toBeDefined()
    expect(data.error.code).toBe('inflight_unsupported')
  })
})

// ---------------------------------------------------------------------------
// Retired SDK runtime -> 422
// ---------------------------------------------------------------------------
describe('POST /v1/in-flight-input — retired SDK runtime', () => {
  it('returns 422 even when historical metadata claims in-flight support', async () => {
    const runtimeId = 'rt-inflight-unsupported-openai'
    const runId = 'run-inflight-unsupported-openai'
    seedSdkActiveRuntime({
      hostSessionId: 'hsid-inflight-unsupported-openai',
      scopeRef: 'agent:inflight-unsupported-openai',
      runtimeId,
      runId,
      provider: 'openai',
      supportsInflightInput: true,
    })

    const res = await fixture.postJson('/v1/in-flight-input', {
      runtimeId,
      runId,
      prompt: 'Input to unsupported SDK',
    })

    expect(res.status).toBe(422)
    const data = (await res.json()) as any
    expect(data.error).toBeDefined()
    expect(data.error.code).toBe('inflight_unsupported')
  })
})

describe('POST /v1/active-run-contributions — disabled rich contribution contract', () => {
  it('rejects malformed contribution requests before ledger writes', async () => {
    const res = await fixture.postJson('/v1/active-run-contributions', {
      inputAttemptId: 'ia_missing_application',
      prompt: 'missing application id',
      selector: {},
    })

    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('malformed_request')
  })

  it('returns a queryable rejected ledger row when no active run exists', async () => {
    const seeded = await fixture.ensureRuntime('active-contrib-no-run')
    const request = {
      selector: { runtimeId: seeded.runtimeId },
      inputAttemptId: 'ia_no_active',
      inputApplicationId: 'iap_no_active',
      idempotencyKey: 'same-app',
      prompt: 'try contributing',
    }

    const first = await fixture.postJson('/v1/active-run-contributions', request)
    const duplicate = await fixture.postJson('/v1/active-run-contributions', request)
    const queried = await fixture.fetchSocket('/v1/active-run-contributions/iap_no_active')

    expect(first.status).toBe(200)
    expect(duplicate.status).toBe(200)
    expect(queried.status).toBe(200)

    const payload = (await first.json()) as any
    expect(payload).toEqual(
      expect.objectContaining({
        status: 'rejected',
        inputApplicationId: 'iap_no_active',
        runtimeId: seeded.runtimeId,
        errorCode: 'no_active_run',
        capability: { supported: false },
      })
    )
    expect(await duplicate.json()).toEqual(payload)
    expect(await queried.json()).toEqual(payload)
  })

  it('rejects expectedRunId mismatch against the active runtime run', async () => {
    fixture.seedSession('hsid-active-contrib', 'active-contrib-mismatch')
    fixture.seedTmuxRuntime('hsid-active-contrib', 'active-contrib-mismatch', 'rt-active-contrib', {
      status: 'busy',
      activeRunId: 'hrc-active-run',
    })

    const res = await fixture.postJson('/v1/active-run-contributions', {
      selector: { runtimeId: 'rt-active-contrib' },
      expectedRunId: 'hrc-other-run',
      inputAttemptId: 'ia_mismatch',
      inputApplicationId: 'iap_mismatch',
      prompt: 'wrong run',
    })

    expect(res.status).toBe(200)
    const payload = (await res.json()) as any
    expect(payload).toEqual(
      expect.objectContaining({
        status: 'rejected',
        inputApplicationId: 'iap_mismatch',
        runtimeId: 'rt-active-contrib',
        runId: 'hrc-active-run',
        errorCode: 'run_mismatch',
        capability: { supported: false },
      })
    )
  })

  it('recommends queue fallback when the contribution feature gate is disabled', async () => {
    const previousGate = process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED']
    process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = '0'
    fixture.seedSession('hsid-active-disabled', 'active-contrib-disabled')
    fixture.seedTmuxRuntime(
      'hsid-active-disabled',
      'active-contrib-disabled',
      'rt-active-disabled',
      {
        status: 'busy',
        activeRunId: 'hrc-active-disabled',
      }
    )

    try {
      const res = await fixture.postJson('/v1/active-run-contributions', {
        selector: {
          sessionRef: {
            scopeRef: 'agent:active-contrib-disabled',
            laneRef: 'default',
          },
        },
        expectedRunId: 'hrc-active-disabled',
        inputAttemptId: 'ia_disabled',
        inputApplicationId: 'iap_disabled',
        prompt: 'would contribute if enabled',
      })

      expect(res.status).toBe(200)
      const payload = (await res.json()) as any
      expect(payload).toEqual(
        expect.objectContaining({
          status: 'queue_recommended',
          inputApplicationId: 'iap_disabled',
          runtimeId: 'rt-active-disabled',
          runId: 'hrc-active-disabled',
          capability: { supported: false, reason: 'feature_disabled' },
        })
      )
      expect(payload.errorCode).toBeUndefined()
    } finally {
      if (previousGate === undefined) {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = undefined
      } else {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = previousGate
      }
    }
  })

  it('recommends queue fallback when a non-SDK active runtime lacks in-flight input', async () => {
    const previousGate = process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED']
    process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = '1'
    fixture.seedSession('hsid-active-tmux-unsupported', 'active-contrib-tmux-unsupported')
    fixture.seedTmuxRuntime(
      'hsid-active-tmux-unsupported',
      'active-contrib-tmux-unsupported',
      'rt-active-tmux-unsupported',
      {
        status: 'busy',
        activeRunId: 'hrc-active-tmux-unsupported',
      }
    )

    try {
      const res = await fixture.postJson('/v1/active-run-contributions', {
        selector: { runtimeId: 'rt-active-tmux-unsupported' },
        expectedRunId: 'hrc-active-tmux-unsupported',
        inputAttemptId: 'ia_tmux_unsupported',
        inputApplicationId: 'iap_tmux_unsupported',
        prompt: 'queue me because this transport cannot accept in-flight input',
      })

      expect(res.status).toBe(200)
      const payload = (await res.json()) as any
      expect(payload).toEqual(
        expect.objectContaining({
          status: 'queue_recommended',
          inputApplicationId: 'iap_tmux_unsupported',
          runtimeId: 'rt-active-tmux-unsupported',
          runId: 'hrc-active-tmux-unsupported',
          capability: { supported: false, reason: 'inflight_unsupported' },
        })
      )
      expect(payload.errorCode).toBeUndefined()
    } finally {
      if (previousGate === undefined) {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = undefined
      } else {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = previousGate
      }
    }
  })

  it('recommends queue fallback when SDK in-flight support is disabled by env', async () => {
    const previousGate = process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED']
    process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = '0'
    seedSdkActiveRuntime({
      hostSessionId: 'hsid-active-sdk-env-disabled',
      scopeRef: 'agent:active-contrib-sdk-env-disabled',
      runtimeId: 'rt-active-sdk-env-disabled',
      runId: 'hrc-active-sdk-env-disabled',
      supportsInflightInput: true,
      provider: 'anthropic',
    })

    try {
      const res = await fixture.postJson('/v1/active-run-contributions', {
        selector: { runtimeId: 'rt-active-sdk-env-disabled' },
        expectedRunId: 'hrc-active-sdk-env-disabled',
        inputAttemptId: 'ia_sdk_env_disabled',
        inputApplicationId: 'iap_sdk_env_disabled',
        prompt: 'env disabled should supersede SDK transport support',
      })

      expect(res.status).toBe(200)
      const payload = (await res.json()) as any
      expect(payload).toEqual(
        expect.objectContaining({
          status: 'queue_recommended',
          inputApplicationId: 'iap_sdk_env_disabled',
          runtimeId: 'rt-active-sdk-env-disabled',
          runId: 'hrc-active-sdk-env-disabled',
          capability: { supported: false, reason: 'feature_disabled' },
        })
      )
      expect(payload.errorCode).toBeUndefined()
    } finally {
      if (previousGate === undefined) {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = undefined
      } else {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = previousGate
      }
    }
  })

  it('recommends queue fallback when SDK runtime metadata lacks in-flight support', async () => {
    const previousGate = process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED']
    process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = '1'
    seedSdkActiveRuntime({
      hostSessionId: 'hsid-active-capability',
      scopeRef: 'agent:active-contrib-capability',
      runtimeId: 'rt-active-capability',
      runId: 'hrc-active-capability',
      supportsInflightInput: false,
      provider: 'anthropic',
    })

    try {
      const res = await fixture.postJson('/v1/active-run-contributions', {
        selector: { runtimeId: 'rt-active-capability' },
        expectedRunId: 'hrc-active-capability',
        inputAttemptId: 'ia_capability',
        inputApplicationId: 'iap_capability',
        prompt: 'provider name alone must not enable delivery',
      })

      expect(res.status).toBe(200)
      const payload = (await res.json()) as any
      expect(payload).toEqual(
        expect.objectContaining({
          status: 'queue_recommended',
          inputApplicationId: 'iap_capability',
          runtimeId: 'rt-active-capability',
          runId: 'hrc-active-capability',
          capability: { supported: false, reason: 'inflight_unsupported' },
        })
      )
      expect(payload.errorCode).toBeUndefined()
    } finally {
      if (previousGate === undefined) {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = undefined
      } else {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = previousGate
      }
    }
  })
})
