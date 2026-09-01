/**
 * T-07655 acceptance 4 — the birth designation renders as a FOURTH truth.
 *
 * The three-truths rule exists because a collapsed answer makes a misplaced
 * scope invisible: an operator sees one home and no way to tell which layer
 * produced it. A designation is a fourth layer with the same hazard. It is not
 * policy (nothing declared it) and not authority (it never held a binding) — it
 * is the record of a DECISION, and it is the only place an operator can read
 * why a scope was born where it was.
 */

import { afterEach, describe, expect, test } from 'bun:test'

import type { ScopeLocation } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import { cmdTargetLocate } from '../cli/handlers-federation.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-07655'
const restores: (() => void)[] = []

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
})

function captureStdout(): () => string {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  restores.push(() => {
    process.stdout.write = original
  })
  return () => chunks.join('')
}

function stubLocate(location: ScopeLocation): void {
  const original = HrcClient.prototype.locateScope
  HrcClient.prototype.locateScope = async () => location
  restores.push(() => {
    HrcClient.prototype.locateScope = original
  })
}

const DESIGNATION = {
  scopeRef: SCOPE,
  homeNodeId: 'max3',
  provenance: 'default_home_node(sender)' as const,
  birthEnvelopeId: 'EN-00722',
  senderScopeRef: 'agent:mable:project:wrkq:task:primary',
  designationEpoch: 1,
  designatedAt: '2026-08-28T05:00:00.000Z',
  state: 'live' as const,
}

function location(overrides: Partial<ScopeLocation> = {}): ScopeLocation {
  return {
    scopeRef: SCOPE,
    localNodeId: 'svc',
    federationConfigured: true,
    gateMode: 'enforce',
    declared: { source: 'none', detail: 'no stanza' },
    ledger: { state: 'absent' },
    registry: { outcome: 'unbound' },
    designation: { outcome: 'none' },
    authority: { state: 'unbound' },
    observed: { scope: 'local-node-only', nodeId: 'svc', runtimeCount: 0, runtimes: [] },
    notes: [],
    ...overrides,
  } as ScopeLocation
}

describe('T-07655 — hrc target locate renders the birth designation', () => {
  test('a live designation names its home, provenance, sender, and envelope', async () => {
    stubLocate(location({ designation: { outcome: 'designated', record: DESIGNATION } }))
    const read = captureStdout()

    await cmdTargetLocate([SCOPE])
    const out = read()

    expect(out).toContain('designation:')
    expect(out).toContain('max3')
    expect(out).toContain('default_home_node(sender)')
    // The sender and the envelope are the audit trail. Without them an operator
    // reading "designated to max3" has no way to check WHY without hand-walking
    // the ledger.
    expect(out).toContain('agent:mable:project:wrkq:task:primary')
    expect(out).toContain('EN-00722')
  })

  test('a designation is reported beside a binding that disagrees, never merged into it', async () => {
    const out = (() => {
      stubLocate(
        location({
          designation: {
            outcome: 'superseded',
            record: { ...DESIGNATION, state: 'superseded', supersededBy: 'explicit_local' },
          },
          registry: {
            outcome: 'bound',
            record: {
              homeNodeId: 'svc',
              createdAt: '2026-08-28T05:01:00.000Z',
              updatedAt: '2026-08-28T05:01:00.000Z',
            },
          },
        } as Partial<ScopeLocation>)
      )
      const read = captureStdout()
      return read
    })()

    await cmdTargetLocate([SCOPE])
    const text = out()

    // Both layers are visible and they disagree on purpose: the scope was
    // designated to max3 and an operator started it on svc instead. Collapsing
    // them would erase exactly the fact worth reading.
    expect(text).toContain('designation:')
    expect(text).toContain('SUPERSEDED by explicit_local')
    expect(text).toContain('registry:   bound -> svc')
  })

  test('an unreadable designation stays unknown rather than becoming none', async () => {
    stubLocate(
      location({
        designation: { outcome: 'unknown', detail: 'registry host unreachable', retryable: true },
      })
    )
    const read = captureStdout()

    await cmdTargetLocate([SCOPE])
    const out = read()

    // §5 fail-closed, applied to the newest layer: reporting an UNREAD
    // designation as absent would tell an operator the scope is free to be born
    // anywhere, which is the one thing a designation exists to deny.
    expect(out).toContain('unknown')
    expect(out).toContain('registry host unreachable')
    expect(out).not.toContain('designation: none')
  })

  test('the json surface carries the designation for machine readers', async () => {
    stubLocate(location({ designation: { outcome: 'designated', record: DESIGNATION } }))
    const read = captureStdout()

    await cmdTargetLocate([SCOPE, '--json'])

    expect(JSON.parse(read())).toMatchObject({
      designation: { outcome: 'designated', record: { homeNodeId: 'max3', designationEpoch: 1 } },
    })
  })
})
