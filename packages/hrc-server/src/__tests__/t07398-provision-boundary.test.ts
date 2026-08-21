/**
 * T-07398 Wave 2b — `intent.provision` carriage and the server dispatch boundary.
 *
 * Two claims, and they pull in opposite directions on purpose:
 *
 *  - CARRIAGE: every existing surface that already accepts a `runtimeIntent`
 *    carries `provision` through VERBATIM. Wave 2b adds no new request-body
 *    field anywhere, so a directive block reaches the summon gate on the shape
 *    the surface already has, or it does not reach it at all.
 *  - BOUNDARY: the sender validated the block, but the server never trusts that.
 *    Shape (top-level scalars only) and the deny-list are re-validated HERE, at
 *    the dispatch boundary, on BOTH entry points — the start/ensure parser and
 *    the semantic-DM parser. The DM parser is the one that currently casts its
 *    `runtimeIntent` straight through without validation, which is exactly the
 *    hole a deny-list enforced only at the sender would leave open.
 */

import { describe, expect, test } from 'bun:test'

import { parseSemanticDmRequest } from '../messages'
import {
  parseEnsureRuntimeRequest,
  parseOpenBrokerSessionRequest,
  parseRuntimeIntent,
  parseStartRuntimeRequest,
} from '../parsers/runtime'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-07398'
const SESSION_REF = `${SCOPE}/lane:main`

const PROVISION = {
  harness: 'codex',
  model: 'gpt-5.6-sol',
  reasoning: 'high',
  node: 'hrcdev',
  approval: 'never',
  remote: true,
} as const

function intentBody(provision: unknown): Record<string, unknown> {
  return {
    placement: 'workspace',
    harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
    ...(provision === undefined ? {} : { provision }),
  }
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  throw new Error('expected the parse to reject')
}

describe('T-07398 intent.provision rides every existing surface verbatim', () => {
  test('start (exact + suffix), ensure, broker session-open and DM all preserve it', () => {
    const surfaces: Record<string, { provision?: unknown }> = {
      parseRuntimeIntent: parseRuntimeIntent(intentBody(PROVISION)),
      'ensure/dm-summon': parseEnsureRuntimeRequest({
        hostSessionId: 'hsid-1',
        intent: intentBody(PROVISION),
      }).intent,
      'exact start': parseStartRuntimeRequest({
        sessionRef: SESSION_REF,
        runtimeIntent: intentBody(PROVISION),
        conflictPolicy: 'reject',
        summonIntent: 'implicit',
        idempotencyKey: 'exact-provision-1',
      }).runtimeIntent as { provision?: unknown },
      'suffix start': parseStartRuntimeRequest({
        baseSessionRef: SESSION_REF,
        runtimeIntent: intentBody(PROVISION),
        conflictPolicy: 'suffix',
        idempotencyKey: 'suffix-provision-1',
      }).runtimeIntent as { provision?: unknown },
      'agent-loop session-open': parseOpenBrokerSessionRequest({
        hostSessionId: 'hsid-1',
        runtimeIntent: intentBody(PROVISION),
      }).runtimeIntent as { provision?: unknown },
      'semantic dm': parseSemanticDmRequest({
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: SESSION_REF },
        body: 'hello',
        runtimeIntent: intentBody(PROVISION),
      }).runtimeIntent as { provision?: unknown },
    }

    for (const [surface, intent] of Object.entries(surfaces)) {
      expect({ surface, provision: intent.provision }).toEqual({
        surface,
        provision: { ...PROVISION },
      })
    }
  })

  test('an absent block stays absent — no surface invents an empty provision', () => {
    expect(parseRuntimeIntent(intentBody(undefined)).provision).toBeUndefined()
  })
})

describe('T-07398 dispatch boundary — shape is re-validated on both entry points', () => {
  test('a nested harness table is INVALID_PROVISION_SHAPE, not a silent pass-through', () => {
    const nested = { claude: { permission_mode: 'bypassPermissions' } }

    expect(codeOf(() => parseRuntimeIntent(intentBody(nested)))).toBe('invalid_provision_shape')
    expect(
      codeOf(() =>
        parseSemanticDmRequest({
          from: { kind: 'entity', entity: 'human' },
          to: { kind: 'session', sessionRef: SESSION_REF },
          body: 'nested spelling must not bypass the deny-list',
          runtimeIntent: intentBody(nested),
        })
      )
    ).toBe('invalid_provision_shape')
  })

  test('a non-scalar value for a known key is INVALID_PROVISION_SHAPE too', () => {
    expect(codeOf(() => parseRuntimeIntent(intentBody({ model: { alias: 'sol' } })))).toBe(
      'invalid_provision_shape'
    )
  })
})

describe('T-07398 dispatch boundary — the deny-list is re-validated on both entry points', () => {
  test('yolo and sandbox are DENIED_PROVISION_KEY wherever they arrive', () => {
    for (const denied of [{ yolo: true }, { sandbox: 'danger-full-access' }]) {
      expect(codeOf(() => parseRuntimeIntent(intentBody(denied)))).toBe('denied_provision_key')
      expect(
        codeOf(() =>
          parseSemanticDmRequest({
            from: { kind: 'entity', entity: 'human' },
            to: { kind: 'session', sessionRef: SESSION_REF },
            body: 'denied key must not survive the DM door',
            runtimeIntent: intentBody(denied),
          })
        )
      ).toBe('denied_provision_key')
    }
  })
})
