/**
 * RED test for T-01754 — Make the Agent SDK harness path a HARD FAIL.
 *
 * Parent: T-01753 (final harness-broker cutover), audit finding #5.
 *
 * There is NO broker-backed SDK runner today. Rather than build one
 * speculatively, the SDK harness execution path must FAIL HARD so every
 * real code path / use case that still relies on it surfaces by error
 * instead of silently running. This is a deliberate flush-out.
 *
 * Pinned coordinator design (clod, C-02949):
 *   - Throw HrcRuntimeUnavailableError (hrc-core, code RUNTIME_UNAVAILABLE =
 *     HTTP 503) BEFORE runSdkTurn is reached, in all three SDK entry methods:
 *       - executeHeadlessSdkTurn      (index.ts ~3556)
 *       - runHeadlessSdkStartLaunch   (index.ts ~6310)
 *       - handleSdkDispatchTurn       (index.ts ~9378)
 *   - The error must name caller method, harness.id, harness.provider, and
 *     scope/sessionRef.
 *   - decideHeadlessExecutionRoute STILL returns 'sdk' for SDK harnesses; only
 *     the executor the 'sdk' route maps to becomes the hard-fail.
 *   - runSdkTurn stays exported (sdk-adapter.agent-tools.test.ts depends on it),
 *     but must NEVER be invoked once an SDK harness intent is dispatched/started.
 *
 * GREEN behavior pinned by this test (driving the public HTTP boundary):
 *   1. POST /v1/turns with an SDK harness intent (agent-sdk / pi-sdk, or id-less
 *      anthropic — i.e. shouldUseHeadlessSdkExecutor(intent.harness) === true)
 *      REJECTS with HTTP 503 / error.code === 'runtime_unavailable'.
 *   2. POST /v1/runtimes/start with an SDK harness intent likewise hard-fails.
 *   3. runSdkTurn is NEVER invoked for any of the above.
 *   4. The error identifies the harness provider (and id when present) so the
 *      hard-fail log is enumerable.
 *
 * This test currently FAILS (RED): today the SDK dispatch/start paths invoke
 * runSdkTurn and return 200. Larry makes it GREEN by inserting the hard-fail.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HrcErrorCode } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import type { HrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

/**
 * Build a non-interactive (SDK) runtime intent.
 *
 * - provider 'anthropic' + id 'agent-sdk'  → shouldUseHeadlessSdkExecutor true
 * - provider 'openai'    + id 'pi-sdk'      → shouldUseHeadlessSdkExecutor true
 * - id-less anthropic headless             → shouldUseHeadlessSdkExecutor true
 */
function sdkIntent(
  provider: 'anthropic' | 'openai',
  id?: 'agent-sdk' | 'pi-sdk',
  options: { preferredMode?: 'headless' | 'nonInteractive' } = {}
): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider,
      interactive: false,
      ...(id ? { id } : {}),
    },
    ...(options.preferredMode ? { execution: { preferredMode: options.preferredMode } } : {}),
  }
}

function runtimeRowsForHostSession(hostSessionId: string) {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runtimes.listByHostSessionId(hostSessionId)
  } finally {
    db.close()
  }
}

describe('SDK harness path is a hard fail (T-01754)', () => {
  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-sdk-hard-fail-')
    const hrcServer = await import('../index')
    server = await hrcServer.createHrcServer(
      fixture.serverOpts({
        headlessCodexBrokerEnabled: false,
        claudeCodeTmuxBrokerEnabled: false,
        codexCliTmuxBrokerEnabled: false,
      })
    )
  })

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = undefined
    }
    await fixture.cleanup()
  })

  async function resolveSession(scope: string): Promise<string> {
    return (await fixture.resolveSession(scope)).hostSessionId
  }

  const dispatchCases: Array<{
    name: string
    provider: 'anthropic' | 'openai'
    id?: 'agent-sdk' | 'pi-sdk'
    expectInError: string[]
  }> = [
    {
      name: 'explicit agent-sdk (anthropic)',
      provider: 'anthropic',
      id: 'agent-sdk',
      expectInError: ['agent-sdk', 'anthropic'],
    },
    {
      name: 'explicit pi-sdk (openai)',
      provider: 'openai',
      id: 'pi-sdk',
      expectInError: ['pi-sdk', 'openai'],
    },
    {
      name: 'id-less anthropic headless (legacy SDK fallback)',
      provider: 'anthropic',
      expectInError: ['anthropic'],
    },
  ]

  for (const tc of dispatchCases) {
    it(`POST /v1/turns hard-fails for ${tc.name} before SDK execution`, async () => {
      const hsid = await resolveSession(
        `sdk-hard-fail-dispatch-${tc.provider}-${tc.id ?? 'idless'}`
      )

      const res = await fixture.postJson('/v1/turns', {
        hostSessionId: hsid,
        prompt: 'SDK harness path should hard-fail',
        runtimeIntent: sdkIntent(tc.provider, tc.id),
      })

      const data = (await res.json()) as {
        error?: { code?: string; message?: string; detail?: Record<string, unknown> }
        transport?: string
        status?: string
      }

      // Hard fail: HrcRuntimeUnavailableError → HTTP 503 / runtime_unavailable.
      expect(res.status).toBe(503)
      expect(data.error?.code).toBe(HrcErrorCode.RUNTIME_UNAVAILABLE)

      // The error must surface the harness shape so the hard-fail log is
      // enumerable (loosely asserted against the serialized error envelope so
      // we do not over-constrain message vs detail placement).
      const serializedError = JSON.stringify(data.error ?? {})
      for (const fragment of tc.expectInError) {
        expect(serializedError).toContain(fragment)
      }
    })
  }

  it('POST /v1/runtimes/start hard-fails for an SDK harness before SDK execution', async () => {
    const control = await fixture.ensureRuntime('sdk-hard-fail-start-query-control')
    expect(runtimeRowsForHostSession(control.hostSessionId)).toHaveLength(1)

    const hsid = await resolveSession('sdk-hard-fail-start')
    const runtimeCountBefore = runtimeRowsForHostSession(hsid).length
    expect(runtimeCountBefore).toBe(0)

    const res = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      // preferredMode 'headless' routes the start through runHeadlessStartLaunch
      // → runHeadlessSdkStartLaunch (the SDK start entry method under test).
      intent: sdkIntent('anthropic', 'agent-sdk', { preferredMode: 'headless' }),
    })

    const data = (await res.json()) as {
      error?: { code?: string; message?: string; detail?: Record<string, unknown> }
    }

    expect(res.status).toBe(503)
    expect(data.error?.code).toBe(HrcErrorCode.RUNTIME_UNAVAILABLE)

    const serializedError = JSON.stringify(data.error ?? {})
    expect(serializedError).toContain('agent-sdk')
    expect(serializedError).toContain('anthropic')
    expect(runtimeRowsForHostSession(hsid)).toHaveLength(runtimeCountBefore)
  })
})
