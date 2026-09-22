/**
 * Durable headless hosting is selected and frozen by ASP. The old direct
 * controller fixture supplied an `agent-runtime-profile/v1`, an HRC-selected
 * driver, and an allocator; v2 must reject that combination before it can
 * choose a substrate or make a Unix broker connection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { HarnessBrokerController } from '../broker/controller'

import { makeBrokerProfile, makeCompileResponse, makeIdentity } from './broker-compile-fixtures'

const NOW = '2026-09-21T00:00:00.000Z'

describe('T-01874 — profile-era durable headless input is refused before substrate allocation', () => {
  let db: HrcDatabase
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hrc-headless-durable-'))
    db = openHrcDatabase(join(dir, 'state.sqlite'))
    db.sessions.insert({
      hostSessionId: 'hostSession_w2',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01874',
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

  it('requires ASPD producer execution instead of deriving a durable driver and substrate in HRC', async () => {
    const identity = makeIdentity()
    const { profile, startRequest } = makeBrokerProfile(identity, {
      brokerDriver: 'codex-app-server',
    })
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('fixture compile response unexpectedly failed')
    let allocations = 0
    let unixConnections = 0
    const controller = new HarnessBrokerController({
      db,
      tmuxAllocator: {
        allocate: async () => {
          allocations += 1
          throw new Error('retired input must not allocate')
        },
      },
      brokerUnixClientFactory: async () => {
        unixConnections += 1
        throw new Error('retired input must not connect')
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
      dispatchEnv: {},
    })

    expect(result.ok).toBe(false)
    expect(allocations).toBe(0)
    expect(unixConnections).toBe(0)
    expect(db.runtimes.getByRuntimeId(String(identity.runtimeId))).toBeNull()
  })
})
