/**
 * RED test (T-01732 / T-01730) — terminal.surface.reported tmux-pane MAPPER.
 *
 * Governing plan: C-02889 on T-01730. When a `claude-code-tmux` or
 * `codex-cli-tmux` driver reports its bound surface, the broker emits a
 * `terminal.surface.reported` event with a `kind: 'tmux-pane'` payload (the
 * pane lease the runtime allocated). The BrokerEventMapper must bind that
 * surface keyed by the PANE id (`surfaceId === paneId`) — the stable, unique
 * lease identifier — for BOTH drivers.
 *
 * At HEAD the mapper derives `surfaceId` as `${socketPath}#${sessionName}`,
 * which (a) is not the pane id and (b) becomes `${socketPath}#undefined` when a
 * tmux-pane payload omits sessionName. Both are wrong for pane leases, so these
 * tests FAIL at HEAD and turn green only once the mapper keys tmux-pane surfaces
 * by paneId with no `#undefined` artifact.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'

type FixtureDb = ReturnType<typeof openHrcDatabase>

function ts(offsetSeconds = 0): string {
  return new Date(Date.UTC(2026, 4, 28, 12, 0, offsetSeconds)).toISOString()
}

type SurfaceFixture = {
  db: FixtureDb
  dir: string
  cleanup: () => Promise<void>
}

let fixture: SurfaceFixture

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-pane-lease-surface-'))
  const db = openHrcDatabase(join(dir, 'test.sqlite'))
  fixture = {
    db,
    dir,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
})

afterEach(async () => {
  await fixture.cleanup()
})

/**
 * Seed the runtime/session/invocation graph for an interactive tmux driver so
 * the mapper can resolve projection context from a bare event envelope.
 */
function seedDriverGraph(driver: 'claude-code-tmux' | 'codex-cli-tmux'): {
  runtimeId: string
  invocationId: InvocationId
} {
  const db = fixture.db
  const now = ts()
  const suffix = driver.replace(/-/g, '_')
  const hostSessionId = `hsid_${suffix}`
  const runtimeId = `runtime_${suffix}`
  const operationId = `op_${suffix}`
  const invocationId = `invocation_${suffix}` as InvocationId
  const scopeRef = `agent:smokey:project:hrc-runtime:task:T-01732:${suffix}`
  const provider = driver === 'claude-code-tmux' ? 'anthropic' : 'openai'
  const harness = driver === 'claude-code-tmux' ? 'claude-code' : 'codex-cli'

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
    harness,
    provider,
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: operationId,
    createdAt: now,
    updatedAt: now,
  })
  db.brokerInvocations.insert({
    invocationId,
    operationId,
    runtimeId,
    brokerProtocol: 'harness-broker/0.1',
    brokerDriver: driver,
    invocationState: 'ready',
    capabilitiesJson: JSON.stringify({}),
    specHash: `sha256:spec-${suffix}`,
    startRequestHash: `sha256:req-${suffix}`,
    selectedProfileHash: `sha256:prof-${suffix}`,
    createdAt: now,
    updatedAt: now,
  })

  return { runtimeId, invocationId }
}

function surfaceEnvelope(
  invocationId: InvocationId,
  payload: Record<string, unknown>
): InvocationEventEnvelope {
  return {
    invocationId,
    seq: 40,
    time: ts(40) as InvocationEventEnvelope['time'],
    type: 'terminal.surface.reported',
    payload: payload as InvocationEventEnvelope['payload'],
  }
}

describe('RED #3: terminal.surface.reported tmux-pane mapper (surfaceId === paneId)', () => {
  it('keys a claude-code-tmux pane surface by paneId (sessionName present)', () => {
    const { runtimeId, invocationId } = seedDriverGraph('claude-code-tmux')
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })

    mapper.apply(
      surfaceEnvelope(invocationId, {
        kind: 'tmux-pane',
        socketPath: '/tmp/hrc-runtime/claude-code-tmux/runtime_claude/tmux.sock',
        sessionId: '$3',
        windowId: '@7',
        paneId: '%12',
        sessionName: 'hrc-claude-code-tmux-runtime_claude',
        windowName: 'main',
      })
    )

    const bindings = fixture.db.surfaceBindings.findByRuntime(runtimeId)
    expect(bindings.length).toBe(1)
    const binding = bindings[0]!
    expect(binding.surfaceId).toBe('%12')
    expect(binding.paneId).toBe('%12')
    expect(binding.surfaceId).not.toContain('#undefined')
  })

  it('keys a codex-cli-tmux pane surface by paneId with no #undefined (sessionName absent)', () => {
    const { runtimeId, invocationId } = seedDriverGraph('codex-cli-tmux')
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })

    mapper.apply(
      surfaceEnvelope(invocationId, {
        kind: 'tmux-pane',
        socketPath: '/tmp/hrc-runtime/codex-cli-tmux/runtime_codex/tmux.sock',
        sessionId: '$5',
        windowId: '@9',
        paneId: '%21',
        // sessionName intentionally omitted — must NOT produce `#undefined`.
        windowName: 'main',
      })
    )

    const bindings = fixture.db.surfaceBindings.findByRuntime(runtimeId)
    expect(bindings.length).toBe(1)
    const binding = bindings[0]!
    expect(binding.surfaceId).toBe('%21')
    expect(binding.paneId).toBe('%21')
    expect(binding.surfaceId).not.toContain('#undefined')
  })
})
