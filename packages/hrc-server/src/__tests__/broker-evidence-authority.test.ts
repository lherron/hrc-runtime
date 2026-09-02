import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { EvidenceAuthorityMatrix } from 'spaces-harness-broker-protocol'

import { buildRuntimeStateJson } from '../broker/controller/persistence'
import {
  FakeBrokerClient,
  NOW,
  makeFixture,
  makeStartInput,
} from './fixtures/broker-controller.fixture'
import type { TestFixture } from './fixtures/broker-controller.fixture'

describe('broker evidence authority persistence', () => {
  let fixture: TestFixture

  beforeEach(async () => {
    fixture = await makeFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test('stores the selected driver hello matrix without deriving it', () => {
    const evidenceAuthority: EvidenceAuthorityMatrix = {
      'invocation-lifecycle': 'broker',
      'harness-lifecycle': 'hook',
      continuation: 'native',
      'input-admission': 'broker',
      'submission-disposition': 'native',
      'turn-bracket': 'native',
      'turn-supervision': 'broker',
      conversation: 'native',
      tool: 'native',
      usage: 'native',
      permission: 'broker',
      diagnostic: 'hook',
      'terminal-surface': 'hook',
      'provider-artifact': 'native',
    }
    const client = new FakeBrokerClient()
    client.helloResponse = {
      ...client.helloResponse,
      drivers: client.helloResponse.drivers.map((driver) => ({
        ...driver,
        evidenceAuthority,
      })),
    }
    const runtimeState = buildRuntimeStateJson(
      { db: fixture.db, now: () => NOW, serverInstanceId: 'server-test' },
      makeStartInput(),
      client.helloResponse,
      client.startResponse,
      NOW
    )

    expect((runtimeState['broker'] as Record<string, unknown>)['evidenceAuthority']).toEqual(
      evidenceAuthority
    )
  })

  test('accepts legacy hello drivers with no evidence matrix', () => {
    const client = new FakeBrokerClient()
    const runtimeState = buildRuntimeStateJson(
      { db: fixture.db, now: () => NOW, serverInstanceId: 'server-test' },
      makeStartInput(),
      client.helloResponse,
      client.startResponse,
      NOW
    )

    expect(runtimeState['broker']).not.toHaveProperty('evidenceAuthority')
  })
})
