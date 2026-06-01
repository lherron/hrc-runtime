/**
 * RED test (T-01809 / T-01801 Phase 0, C-03099 item 5) — MINIMAL surfacing of
 * the direct-tmux degraded control state via the runtime inspect path.
 *
 * Phase 0 must not defer ALL visibility to Phase 5: once the degraded fallback
 * persists `control.mode='direct-tmux-degraded'` + `brokerAttached=false` into
 * `runtime_state_json`, an operator running `hrc runtime inspect` must be able
 * to SEE that the runtime is in degraded direct-tmux control rather than a
 * silent, permanently-`started`/busy runtime with no explanation.
 *
 * At HEAD `InspectRuntimeResponse` carries no control-mode/broker-attachment
 * field, so this test FAILS. It turns green once the inspect handler surfaces
 * the persisted control state (minimal: mode + brokerAttached).
 *
 * Exercises the REAL server over its unix socket; no tmux/harness needed because
 * the degraded state is read straight from persisted runtime_state_json.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-degraded-inspect-surface-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

describe('RED: inspect surfaces direct-tmux-degraded control state (T-01809)', () => {
  it('exposes control.mode=direct-tmux-degraded + brokerAttached=false from runtime_state_json', async () => {
    const hostSessionId = 'hsid_inspect_degraded'
    const scopeRef = 'agent:smokey:project:hrc-runtime:task:T-01809:inspect'
    const runtimeId = 'runtime_inspect_degraded'
    const runId = 'run_inspect_degraded'
    const now = fixture.now()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.sessions.insert({
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        // Degraded but NOT healthy-ready, with the turn's run still active.
        status: 'busy',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        activeRunId: runId,
        tmuxJson: {
          socketPath: fixture.tmuxSocketPath,
          sessionName: 'hrc-claude-code-tmux-runtime_inspect_degraded',
          windowName: 'main',
          sessionId: '$1',
          windowId: '@1',
          paneId: '%1',
        },
        runtimeStateJson: {
          control: { mode: 'direct-tmux-degraded', brokerAttached: false },
        },
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
    } finally {
      db.close()
    }

    const res = await fixture.postJson('/v1/runtimes/inspect', { runtimeId })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      control?: { mode?: unknown; brokerAttached?: unknown } | undefined
    }

    expect(body.control?.mode).toBe('direct-tmux-degraded')
    expect(body.control?.brokerAttached).toBe(false)
  })
})
