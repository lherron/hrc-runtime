/**
 * The profile-era direct controller start path was retired by the v2 ASPD
 * boundary. A lease can only be allocated from the producer's frozen
 * execution declaration; accepting this input would reintroduce HRC-side
 * profile/driver authority.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { HarnessBrokerController } from '../broker/controller'

import {
  makeCompileResponse,
  makeIdentity,
  makeInteractiveTmuxProfile,
} from './broker-compile-fixtures'

const NOW = '2026-09-21T00:00:00.000Z'

describe('T-01733 — profile-era pane lease requests are refused before allocation', () => {
  let db: HrcDatabase
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hrc-pane-lease-generation-'))
    db = openHrcDatabase(join(dir, 'state.sqlite'))
    db.sessions.insert({
      hostSessionId: 'hostSession_w2',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01733',
      laneRef: 'main',
      generation: 7,
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

  it('requires a producer-selected execution before it can persist a pane lease', async () => {
    const identity = makeIdentity({ generation: 7 })
    const { profile, startRequest } = makeInteractiveTmuxProfile(identity)
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('fixture compile response unexpectedly failed')
    let allocations = 0
    const controller = new HarnessBrokerController({
      db,
      tmuxAllocator: {
        allocate: async () => {
          allocations += 1
          throw new Error('retired input must not allocate')
        },
      },
      now: () => NOW,
    } as ConstructorParameters<typeof HarnessBrokerController>[0])

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
    expect(db.runtimes.getByRuntimeId(String(identity.runtimeId))).toBeNull()
  })
})
