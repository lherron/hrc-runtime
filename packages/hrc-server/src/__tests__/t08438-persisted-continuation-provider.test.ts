import { describe, expect, it } from 'bun:test'

import type { HrcContinuationRef } from 'hrc-core'

import { toRuntimeContinuationRef } from '../broker-decisions'
import { HOST_SESSION_ID, RUNTIME_ID, envelope } from './broker-event-mapper-fixtures'

import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture'

const persistedProducerContinuations = [
  {
    name: 'codex app-server thread',
    continuation: {
      provider: 'codex',
      kind: 'thread',
      key: '01a00cfd-0740-7872-91f3-0cf61a25cafa',
    },
  },
  {
    name: 'historical agent-harness OpenAI Codex session',
    continuation: {
      provider: 'openai-codex',
      kind: 'session',
      key: 'agent-harness-session-08438',
    },
  },
] satisfies readonly { name: string; continuation: HrcContinuationRef }[]

const harness = createBrokerEventMapperTestFixture()

describe('T-08438 persisted continuation provider projection', () => {
  it('persists producer-owned provider labels unchanged on runtime and session rows', () => {
    const mapper = harness.makeMapper()

    for (const [offset, { continuation }] of persistedProducerContinuations.entries()) {
      mapper.apply(envelope('continuation.updated', 8 + offset, continuation))

      expect(harness.fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.continuation).toEqual(
        continuation
      )
      expect(harness.fixture.db.sessions.getByHostSessionId(HOST_SESSION_ID)?.continuation).toEqual(
        continuation
      )
    }
  })

  it('preserves a producer-omitted kind as an absent property', () => {
    const mapper = harness.makeMapper()
    const legacyContinuation = {
      provider: 'anthropic',
      key: 'legacy-kindless-session-08438',
    } satisfies HrcContinuationRef

    mapper.apply(envelope('continuation.updated', 8, legacyContinuation))

    const persisted = harness.fixture.db.sessions.getByHostSessionId(HOST_SESSION_ID)?.continuation
    expect(persisted).toEqual(legacyContinuation)
    expect(Object.hasOwn(persisted ?? {}, 'kind')).toBe(false)
  })

  it('keeps the producer label out of the closed ASP selection field', () => {
    const continuation = persistedProducerContinuations[0]!.continuation

    expect(toRuntimeContinuationRef(continuation)).toMatchObject({
      schemaVersion: 'runtime-continuation/v1',
      hrc: {
        provider: 'openai',
        continuationId: continuation.key,
        key: continuation.key,
      },
      broker: {
        provider: 'codex',
        kind: 'thread',
        continuationId: continuation.key,
        key: continuation.key,
      },
      source: 'harness-broker',
    })
  })

  it('does not invent an HRC selection provider for an opaque producer label', () => {
    expect(
      toRuntimeContinuationRef({
        provider: 'arris',
        kind: 'host-incarnation',
        key: 'host-incarnation-08438',
      })
    ).toBeUndefined()
  })
})
