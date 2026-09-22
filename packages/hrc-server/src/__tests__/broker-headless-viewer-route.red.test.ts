/**
 * Presentation is a property of ASP's accepted execution declaration. HRC
 * neither derives a viewer from a driver nor turns a caller's route policy into
 * a lease allocation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { HarnessBrokerController } from '../broker/controller'

import { makeBrokerProfile, makeCompileResponse, makeIdentity } from './broker-compile-fixtures'

const NOW = '2026-09-21T00:00:00.000Z'

describe('T-04921 — profile-era viewer routing is refused before presentation allocation', () => {
  let db: HrcDatabase
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hrc-viewer-route-'))
    db = openHrcDatabase(join(dir, 'state.sqlite'))
    db.sessions.insert({
      hostSessionId: 'hostSession_viewer',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-04921',
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('requires an accepted producer presentation surface instead of an HRC route decision', async () => {
    const identity = makeIdentity({ hostSessionId: 'hostSession_viewer' as never })
    const { profile, startRequest } = makeBrokerProfile(identity, {
      brokerDriver: 'codex-app-server',
    })
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('fixture compile response unexpectedly failed')
    let allocations = 0
    const controller = new HarnessBrokerController({
      db,
      tmuxTuiAllocator: {
        allocate: async () => {
          allocations += 1
          throw new Error('retired input must not allocate')
        },
      },
      now: () => NOW,
    } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])

    const result = await controller.start({
      plan: response.plan,
      profile,
      startRequest,
      specHash: profile.harnessInvocation.specHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      identity,
      routeDecision: { operatorPresentation: 'tmux-tui' },
      dispatchEnv: {},
    } as never)

    expect(result.ok).toBe(false)
    expect(allocations).toBe(0)
    expect(db.runtimes.getByRuntimeId(String(identity.runtimeId))).toBeNull()
  })
})
