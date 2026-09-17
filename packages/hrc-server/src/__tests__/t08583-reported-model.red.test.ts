/**
 * RED tests (T-08583) — HRC records the model Codex actually runs.
 *
 * The harness broker attaches the Codex-reported model identity to every
 * `usage.updated` event (`payload.model = { id, source }`, T-08430), but
 * hrc-server consumes no `usage.updated` today, so `hrc runtime inspect`
 * shows no model for any Codex agent.
 *
 * Expected behavior:
 * - `usage.updated` WITH `model` stores the reported identity on the runtime
 *   (latest wins) and inspect surfaces it with its source.
 * - `usage.updated` WITHOUT `model` stores nothing (omission is not a claim).
 * - A malformed `model` stores nothing and never fails the projection.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { BrokerEventMapper } from '../broker/event-mapper'

import {
  RUNTIME_ID,
  type SeededFixture,
  envelope,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

let fx: SeededFixture

afterEach(async () => {
  await fx?.cleanup()
})

function reportedModelOf(runtimeId: string): unknown {
  return (fx.db.runtimes.getByRuntimeId(runtimeId)?.runtimeStateJson as Record<string, unknown>)?.[
    'reportedModel'
  ]
}

describe('[RED T-08583] usage.updated records the Codex-reported model', () => {
  it('stores the reported identity on the runtime', async () => {
    fx = await makeSeededFixture()
    const mapper = new BrokerEventMapper({ db: fx.db })

    mapper.apply(
      envelope('usage.updated', 1, {
        usage: { inputTokens: 10, outputTokens: 5 },
        model: { id: 'muse-spark-1.3-contributor', source: 'provider-response' },
      })
    )

    expect(reportedModelOf(RUNTIME_ID)).toMatchObject({
      id: 'muse-spark-1.3-contributor',
      source: 'provider-response',
    })
  })

  it('latest usage.updated wins', async () => {
    fx = await makeSeededFixture()
    const mapper = new BrokerEventMapper({ db: fx.db })

    mapper.apply(
      envelope('usage.updated', 1, {
        usage: {},
        model: { id: 'gpt-5-codex', source: 'harness-config' },
      })
    )
    mapper.apply(
      envelope('usage.updated', 2, {
        usage: {},
        model: { id: 'muse-spark-1.3-contributor', source: 'provider-response' },
      })
    )

    expect(reportedModelOf(RUNTIME_ID)).toMatchObject({
      id: 'muse-spark-1.3-contributor',
      source: 'provider-response',
    })
  })

  it('stores nothing when model is omitted', async () => {
    fx = await makeSeededFixture()
    const mapper = new BrokerEventMapper({ db: fx.db })

    mapper.apply(envelope('usage.updated', 1, { usage: { inputTokens: 1 } }))

    expect(reportedModelOf(RUNTIME_ID)).toBeUndefined()
  })

  it('stores nothing for a malformed model and still applies the event', async () => {
    fx = await makeSeededFixture()
    const mapper = new BrokerEventMapper({ db: fx.db })

    const result = mapper.apply(
      envelope('usage.updated', 1, {
        usage: {},
        model: { id: '', source: 'provider-response' },
      } as never)
    )

    expect(reportedModelOf(RUNTIME_ID)).toBeUndefined()
    expect(result.lifecycleEvents).toEqual([])
  })

  it('omission never clears a previously reported identity', async () => {
    fx = await makeSeededFixture()
    const mapper = new BrokerEventMapper({ db: fx.db })

    mapper.apply(
      envelope('usage.updated', 1, {
        usage: {},
        model: { id: 'muse-spark-1.3-contributor', source: 'provider-response' },
      })
    )
    mapper.apply(envelope('usage.updated', 2, { usage: {} }))

    expect(reportedModelOf(RUNTIME_ID)).toMatchObject({
      id: 'muse-spark-1.3-contributor',
      source: 'provider-response',
    })
  })

  it('ignores usage.updated from a stale generation', async () => {
    fx = await makeSeededFixture()
    const mapper = new BrokerEventMapper({ db: fx.db })
    fx.db.runtimes.update(RUNTIME_ID, {
      generation: 2,
      runtimeStateJson: { status: 'busy', generation: 2 },
      updatedAt: ts(10),
    })

    mapper.apply(
      envelope('usage.updated', 1, {
        usage: {},
        model: { id: 'muse-spark-1.3-contributor', source: 'provider-response' },
      })
    )

    expect(reportedModelOf(RUNTIME_ID)).toBeUndefined()
  })
})
