import { afterEach, describe, expect, test } from 'bun:test'

import type { FederationRetirementResult, LocateBindingsReport, ScopeLocation } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import { cmdDoctor, cmdFederationRetire } from '../cli/handlers-federation.js'
import { CliStatusExit } from '../cli/shared.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06613'
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

function stubRetirement(result: FederationRetirementResult): string[] {
  const original = HrcClient.prototype.retireFederationScope
  const calls: string[] = []
  HrcClient.prototype.retireFederationScope = async (request) => {
    calls.push(`${request.scopeRef}:${request.reason}`)
    return { ...result, request }
  }
  restores.push(() => {
    HrcClient.prototype.retireFederationScope = original
  })
  return calls
}

function retirementResult(
  overrides: Partial<FederationRetirementResult> = {}
): FederationRetirementResult {
  return {
    request: { scopeRef: SCOPE, reason: 'operator retirement' },
    ok: true,
    outcome: 'retired',
    state: 'retired',
    retryable: false,
    detail: 'old home is permanently fenced and the registry binding is absent',
    ...overrides,
  }
}

describe('hrc federation retire', () => {
  test('calls the single ordered-retirement SDK operation', async () => {
    const calls = stubRetirement(retirementResult())
    const read = captureStdout()

    await cmdFederationRetire([SCOPE, '--reason', 'operator retirement'])

    expect(calls).toEqual([`${SCOPE}:operator retirement`])
    expect(read()).toContain('OK RETIRE retired: retired')
    expect(read()).toContain('permanently fenced')
  })

  test('prints a visible retryable mid-write failure before returning exit 1', async () => {
    stubRetirement(
      retirementResult({
        ok: false,
        outcome: 'registry-unavailable',
        state: 'fenced-registry-pending',
        retryable: true,
        detail: 'old home is fenced; retry retirement to delete the registry binding',
      })
    )
    const read = captureStdout()

    await expect(
      cmdFederationRetire([SCOPE, '--reason', 'operator retirement'])
    ).rejects.toBeInstanceOf(CliStatusExit)
    expect(read()).toContain('REFUSED RETIRE registry-unavailable: fenced-registry-pending')
  })

  test('requires an operator reason', async () => {
    await expect(cmdFederationRetire([SCOPE])).rejects.toThrow('requires --reason')
  })

  test('commander preserves scope and reason', async () => {
    const calls = stubRetirement(retirementResult())
    captureStdout()
    const { buildProgram } = await import('../cli/build-program.js')

    await buildProgram().parseAsync(
      ['federation', 'retire', SCOPE, '--reason', 'operator retirement'],
      { from: 'user' }
    )

    expect(calls).toEqual([`${SCOPE}:operator retirement`])
  })
})

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

function stubBindings(report: LocateBindingsReport): void {
  const originalBindings = HrcClient.prototype.listPlacementBindings
  const originalStatus = HrcClient.prototype.getStatus
  HrcClient.prototype.listPlacementBindings = async () => report
  HrcClient.prototype.getStatus = (async () => ({
    uptime: 42,
    node: {
      nodeId: 'max3',
      nodeIdProvenance: 'declared',
      mode: 'federated',
      configPath: '/state/federation.json',
      configExists: true,
      peerCount: 1,
      peers: [],
    },
    peerHealth: [
      {
        nodeId: 'lab',
        state: 'healthy',
        checkedAt: '2026-07-20T00:00:00.000Z',
        answeredAt: '2026-07-20T00:00:00.010Z',
        latencyMs: 10,
      },
    ],
  })) as typeof HrcClient.prototype.getStatus
  restores.push(() => {
    HrcClient.prototype.listPlacementBindings = originalBindings
    HrcClient.prototype.getStatus = originalStatus
  })
}

describe('hrc doctor', () => {
  const report = (overrides: Partial<LocateBindingsReport['scan']> = {}): LocateBindingsReport => ({
    localNodeId: 'max3',
    federationConfigured: true,
    gateMode: 'advisory',
    scan: { scanned: 1, skewed: [], unreadable: [], ...overrides },
  })

  test('reports a home-only binding scan as healthy', async () => {
    stubBindings(report())
    const read = captureStdout()
    await cmdDoctor([])
    expect(read()).toContain('+ placement-skew')
  })

  test('explains that skew requires retirement followed by fresh establishment', async () => {
    stubBindings(
      report({
        skewed: [
          {
            scopeRef: SCOPE,
            skew: {
              kind: 'pin-vs-binding',
              pinKey: 'hrc-runtime:T-06613',
              pinnedNodeId: 'lab',
              boundNodeId: 'max3',
              detail: 'skewed',
            },
          },
        ],
      })
    )
    const read = captureStdout()
    await cmdDoctor([])
    expect(read()).toContain('Retire the old binding before establishing fresh elsewhere')
  })

  test('--strict preserves its nonzero warning behavior', async () => {
    stubBindings(
      report({
        skewed: [
          {
            scopeRef: SCOPE,
            skew: {
              kind: 'pin-vs-binding',
              pinKey: 'k',
              pinnedNodeId: 'lab',
              boundNodeId: 'max3',
              detail: 'skewed',
            },
          },
        ],
      })
    )
    captureStdout()
    await expect(cmdDoctor(['--strict'])).rejects.toBeInstanceOf(CliStatusExit)
  })
})

void baseLocation
void stubLocate
