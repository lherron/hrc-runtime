import { afterEach, describe, expect, test } from 'bun:test'

import type { FederationRuntimeProjectionReport, ScopeLocation } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import { cmdTargetLocate } from '../cli/handlers-federation.js'
import { cmdRuntimeList } from '../cli/handlers-runtime.js'
import { CliStatusExit } from '../cli/shared.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06613'
const BINDING = {
  homeNodeId: 'max3',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
}
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

function baseLocation(overrides: Partial<ScopeLocation> = {}): ScopeLocation {
  return {
    scopeRef: SCOPE,
    localNodeId: 'max3',
    federationConfigured: true,
    gateMode: 'advisory',
    declared: { source: 'none', detail: 'no stanza' },
    ledger: { state: 'absent' },
    registry: { outcome: 'unbound' },
    designation: { outcome: 'none' },
    authority: { state: 'unbound' },
    observed: { scope: 'local-node-only', nodeId: 'max3', runtimeCount: 0, runtimes: [] },
    notes: [],
    ...overrides,
  }
}

function stubLocate(location: ScopeLocation): void {
  const original = HrcClient.prototype.locateScope
  HrcClient.prototype.locateScope = async () => location
  restores.push(() => {
    HrcClient.prototype.locateScope = original
  })
}

describe('hrc target locate', () => {
  test('--json emits a home-only binding with no epoch or birth provenance', async () => {
    stubLocate(
      baseLocation({
        ledger: { state: 'active', record: BINDING },
        authority: { state: 'bound', source: 'ledger', record: BINDING, isLocal: true },
      })
    )
    const read = captureStdout()

    await cmdTargetLocate([SCOPE, '--json'])

    const result = JSON.parse(read()) as ScopeLocation
    expect(result.authority).toMatchObject({ state: 'bound', record: { homeNodeId: 'max3' } })
    expect(read()).not.toContain('placementEpoch')
    expect(read()).not.toContain('birthClass')
    expect(read()).not.toContain('authorityProvenance')
  })

  test('human output keeps declared, authority, ledger, registry, and observed separate', async () => {
    stubLocate(
      baseLocation({
        declared: {
          source: 'default_home_node',
          nodeId: 'max3',
          profilePath: '/agents/mable/agent-profile.toml',
        },
        ledger: { state: 'active', record: BINDING },
        registry: { outcome: 'not-consulted', detail: 'local ledger answered' },
        authority: { state: 'bound', source: 'ledger', record: BINDING, isLocal: true },
      })
    )
    const read = captureStdout()

    await cmdTargetLocate([SCOPE])

    expect(read()).toContain('declared:')
    expect(read()).toContain('authority:')
    expect(read()).toContain('ledger:')
    expect(read()).toContain('registry:')
    expect(read()).toContain('observed:')
  })

  test('--fail-on-skew exits 1 when a declared constraint disagrees with the home', async () => {
    stubLocate(
      baseLocation({
        skew: {
          kind: 'pin-vs-binding',
          pinKey: 'hrc-runtime:T-06613',
          pinnedNodeId: 'lab',
          boundNodeId: 'max3',
          detail: 'retire on max3 before fresh establishment on lab',
        },
      })
    )
    captureStdout()
    await expect(cmdTargetLocate([SCOPE, '--fail-on-skew'])).rejects.toBeInstanceOf(CliStatusExit)
  })

  test('an unreachable registry renders as UNKNOWN, not unbound', async () => {
    stubLocate(
      baseLocation({
        registry: { outcome: 'unknown', detail: 'connect ECONNREFUSED', retryable: true },
        authority: { state: 'unknown', detail: 'connect ECONNREFUSED', retryable: true },
      })
    )
    const read = captureStdout()
    await cmdTargetLocate([SCOPE])
    expect(read()).toContain('UNKNOWN')
    expect(read()).not.toMatch(/authority:\s+unbound/)
  })
})

describe('hrc runtime list --all-nodes', () => {
  test('renders node-labelled peer observations', async () => {
    const original = HrcClient.prototype.listFederatedRuntimes
    const report: FederationRuntimeProjectionReport = {
      localNodeId: 'svc',
      generatedAt: '2026-07-20T00:01:00.000Z',
      nodes: [
        {
          nodeId: 'svc',
          state: 'answered',
          checkedAt: '2026-07-20T00:01:00.000Z',
          answeredAt: '2026-07-20T00:01:00.000Z',
          latencyMs: 0,
          runtimes: [],
        },
        {
          nodeId: 'lab',
          state: 'unreachable',
          checkedAt: '2026-07-20T00:01:00.000Z',
          answeredAt: '2026-07-20T00:00:00.000Z',
          latencyMs: 1500,
          detail: 'probe timed out',
          runtimes: [],
        },
      ],
    }
    HrcClient.prototype.listFederatedRuntimes = async () => report
    restores.push(() => {
      HrcClient.prototype.listFederatedRuntimes = original
    })
    const read = captureStdout()

    await cmdRuntimeList(['--all-nodes'])

    expect(read()).toContain('node svc: answered')
    expect(read()).toContain('node lab: unreachable')
  })
})
