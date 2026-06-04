/**
 * T-01884 — regression for the Ph4c LIVE durability gap.
 *
 * Ph4c (T-01879) proved live that a durable HEADLESS runtime does NOT survive a
 * daemon restart usably: the leased-tmux substrate + unix broker stay alive, but
 * the runtime row is left stale/broker-ipc-unavailable by startup reconcile, so
 * `getReusableHeadlessRuntimeForSession` EXCLUDES it (it filters out unavailable
 * status). The dispatch handler then provisioned a BRAND-NEW broker, orphaning the
 * live lease.
 *
 * `getDurableHeadlessRuntimeForReattach` closes the SELECTION half of the gap: it
 * selects a durable headless runtime for reattach keyed by runtime-hosting TRUTH
 * (durable unix endpoint + leased-tmux substrate), DELIBERATELY including
 * unavailable-status rows, so the dispatch handler can lazily reattach + reuse the
 * SAME runtime instead of provisioning a duplicate. End-to-end reattach+reuse is
 * proven LIVE in Ph4c re-run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  getDurableHeadlessRuntimeForReattach,
  getReusableHeadlessRuntimeForSession,
} from '../runtime-select'

const HOST_SESSION_ID = 'hsid_t01884'
const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:T-01884'
const LANE_REF = 'main'

let dir: string
let db: HrcDatabase

function seedSession(): void {
  const now = new Date().toISOString()
  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

type SeedOpts = {
  runtimeId: string
  status: string
  durable: boolean
  transport?: string
}

function seedRuntime(opts: SeedOpts): void {
  const now = new Date().toISOString()
  const { runtimeId, status, durable } = opts
  const transport = opts.transport ?? 'headless'
  db.runtimes.insert({
    runtimeId,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport,
    harness: 'codex-app-server',
    provider: 'openai',
    status,
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeInvocationId: `inv-${runtimeId}`,
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId,
      hostSessionId: HOST_SESSION_ID,
      generation: 1,
      status,
      broker: {
        protocolVersion: 'harness-broker/0.2',
        generation: 1,
        // Durable: unix endpoint + leased-tmux substrate (brokerWindow present,
        // tuiWindow ABSENT ⇒ presentation:none). Non-durable: neither.
        ...(durable
          ? {
              endpoint: {
                kind: 'unix-jsonrpc-ndjson',
                socketPath: `/tmp/hrc-t01884/${runtimeId}/b.sock`,
                attachTokenRef: {
                  kind: 'file',
                  path: `/tmp/hrc-t01884/${runtimeId}/attach.token`,
                  redacted: true,
                },
              },
              brokerWindow: {
                socketPath: `/tmp/hrc-t01884/${runtimeId}/btmux.sock`,
                sessionName: `hrc-codex-app-server-${runtimeId}`,
                sessionId: '$0',
                windowId: '@0',
                paneId: '%0',
              },
            }
          : {}),
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-t01884-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  seedSession()
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('T-01884 durable headless reattach selection', () => {
  it('RED: a stale durable headless runtime is selected for reattach but EXCLUDED by the reuse selector', () => {
    seedRuntime({ runtimeId: 'rt-durable-stale', status: 'stale', durable: true })

    // The gap: the reuse selector drops it because status is unavailable.
    expect(
      getReusableHeadlessRuntimeForSession(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
    ).toBeNull()

    // The fix: the reattach selector picks it up by hosting truth (durable
    // unix endpoint + leased-tmux substrate), despite the stale status.
    const picked = getDurableHeadlessRuntimeForReattach(
      db,
      HOST_SESSION_ID,
      'openai',
      'codex-app-server'
    )
    expect(picked?.runtimeId).toBe('rt-durable-stale')
  })

  it('also recovers a broker-ipc-unavailable durable headless runtime', () => {
    seedRuntime({ runtimeId: 'rt-ipc-unavail', status: 'broker-ipc-unavailable', durable: true })
    expect(
      getDurableHeadlessRuntimeForReattach(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
        ?.runtimeId
    ).toBe('rt-ipc-unavail')
  })

  it('does NOT select a non-durable (daemon-child) headless runtime', () => {
    seedRuntime({ runtimeId: 'rt-daemon-child', status: 'stale', durable: false })
    expect(
      getDurableHeadlessRuntimeForReattach(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
    ).toBeNull()
  })

  it('does NOT select a terminated durable headless runtime (truly gone)', () => {
    seedRuntime({ runtimeId: 'rt-terminated', status: 'terminated', durable: true })
    expect(
      getDurableHeadlessRuntimeForReattach(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
    ).toBeNull()
  })

  it('does NOT select an interactive (tmux) durable runtime — headless only', () => {
    seedRuntime({
      runtimeId: 'rt-interactive',
      status: 'stale',
      durable: true,
      transport: 'tmux',
    })
    expect(
      getDurableHeadlessRuntimeForReattach(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
    ).toBeNull()
  })
})
