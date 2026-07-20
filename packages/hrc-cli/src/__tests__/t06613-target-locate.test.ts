/**
 * T-06613 — CLI surface for `hrc target locate` and `hrc doctor`.
 *
 * Renders against a stubbed client: the placement semantics are proven in
 * hrc-server's locate suite, and what matters here is that an operator reading
 * the output can tell skew from expected divergence WITHOUT already knowing the
 * rule. A report that renders a skew and an unpinned-elsewhere note identically
 * would pass every server-side test and still mislead every reader.
 */

import { afterEach, describe, expect, test } from 'bun:test'

import type { LocateBindingsReport, ScopeLocation } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import { cmdDoctor, cmdTargetLocate } from '../cli/handlers-federation.js'
import { CliStatusExit } from '../cli/shared.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06613'

function baseLocation(overrides: Partial<ScopeLocation> = {}): ScopeLocation {
  return {
    scopeRef: SCOPE,
    localNodeId: 'max3',
    federationConfigured: true,
    gateMode: 'advisory',
    declared: { source: 'none', detail: 'no stanza' },
    ledger: { state: 'absent' },
    registry: { outcome: 'unbound' },
    authority: { state: 'unbound' },
    observed: { scope: 'local-node-only', nodeId: 'max3', runtimeCount: 0, runtimes: [] },
    notes: [],
    birthChain: { state: 'not-applicable', detail: 'policy-born' },
    ...overrides,
  } as ScopeLocation
}

const boundRecord = {
  homeNodeId: 'max3',
  placementEpoch: 2,
  birthClass: 'policy-born' as const,
  establishmentProvenance: 'default_home_node' as const,
  authorityProvenance: { kind: 'policy' },
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
  })) as typeof HrcClient.prototype.getStatus
  restores.push(() => {
    HrcClient.prototype.listPlacementBindings = originalBindings
    HrcClient.prototype.getStatus = originalStatus
  })
}

describe('hrc target locate', () => {
  test('--json emits the location verbatim', async () => {
    const location = baseLocation({
      authority: { state: 'bound', source: 'ledger', record: boundRecord, isLocal: true },
    })
    stubLocate(location)
    const read = captureStdout()

    await cmdTargetLocate([SCOPE, '--json'])

    expect(JSON.parse(read())).toMatchObject({ scopeRef: SCOPE })
  })

  test('human output shows declared, authority, ledger, registry, and observed on their own lines', async () => {
    stubLocate(
      baseLocation({
        declared: {
          source: 'default_home_node',
          nodeId: 'max3',
          profilePath: '/agents/mable/agent-profile.toml',
        },
        ledger: { state: 'active', record: boundRecord },
        registry: { outcome: 'not-consulted', detail: 'local ledger answered' },
        authority: { state: 'bound', source: 'ledger', record: boundRecord, isLocal: true },
      })
    )
    const read = captureStdout()

    await cmdTargetLocate([SCOPE])
    const out = read()

    expect(out).toContain('declared:')
    expect(out).toContain('authority:')
    expect(out).toContain('ledger:')
    expect(out).toContain('registry:')
    expect(out).toContain('observed:')
    // Birth class and establishment provenance are part of the AC's contract.
    expect(out).toContain('policy-born')
    expect(out).toContain('default_home_node')
  })

  test('SKEW is rendered prominently and names the remedy', async () => {
    stubLocate(
      baseLocation({
        declared: {
          source: 'pin',
          pinKey: 'hrc-runtime:T-06613',
          nodeId: 'mini',
          profilePath: '/agents/mable/agent-profile.toml',
        },
        authority: { state: 'bound', source: 'ledger', record: boundRecord, isLocal: true },
        skew: {
          kind: 'pin-vs-binding',
          pinKey: 'hrc-runtime:T-06613',
          pinnedNodeId: 'mini',
          boundNodeId: 'max3',
          placementEpoch: 2,
          establishmentProvenance: 'default_home_node',
          detail:
            'SKEW: pin says mini, established on max3.\nmax3 keeps summon authority.\nRebuild the binding to move it.',
        },
      })
    )
    const read = captureStdout()

    await cmdTargetLocate([SCOPE])
    const out = read()

    expect(out).toContain('!! SKEW')
    expect(out).toContain('keeps summon authority')
    expect(out).toContain('Rebuild')
  })

  test('human output names a matched task-default declaration', async () => {
    stubLocate(
      baseLocation({
        declared: {
          source: 'task-default',
          taskKey: 'T-06613',
          nodeId: 'lab',
          profilePath: '/agents/mable/agent-profile.toml',
        },
      })
    )
    const read = captureStdout()

    await cmdTargetLocate([SCOPE])

    expect(read()).toContain('task-default "T-06613" = lab')
  })

  test('an unpinned scope established elsewhere renders as a NOTE, never as skew', async () => {
    stubLocate(
      baseLocation({
        declared: {
          source: 'default_home_node',
          nodeId: 'max3',
          profilePath: '/agents/mable/agent-profile.toml',
        },
        authority: {
          state: 'bound',
          source: 'ledger',
          record: { ...boundRecord, homeNodeId: 'mini' },
          isLocal: false,
        },
        notes: [
          {
            code: 'unpinned-established-elsewhere',
            detail: 'Not skew: default_home_node routes implicit summons; it does not constrain.',
          },
        ],
      })
    )
    const read = captureStdout()

    await cmdTargetLocate([SCOPE])
    const out = read()

    expect(out).not.toContain('!! SKEW')
    expect(out).toContain('note: Not skew')
  })

  test('--fail-on-skew exits 1 only when skew is present', async () => {
    stubLocate(baseLocation())
    const read = captureStdout()
    await cmdTargetLocate([SCOPE, '--fail-on-skew'])
    read()
  })

  test('--fail-on-skew exits 1 when skew IS present', async () => {
    stubLocate(
      baseLocation({
        skew: {
          kind: 'pin-vs-binding',
          pinKey: 'k',
          pinnedNodeId: 'mini',
          boundNodeId: 'max3',
          placementEpoch: 1,
          establishmentProvenance: 'pin',
          detail: 'skewed',
        },
      })
    )
    captureStdout()

    await expect(cmdTargetLocate([SCOPE, '--fail-on-skew'])).rejects.toBeInstanceOf(CliStatusExit)
  })

  test('an unreachable registry renders as UNKNOWN, not as unbound', async () => {
    stubLocate(
      baseLocation({
        registry: { outcome: 'unknown', detail: 'connect ECONNREFUSED', retryable: true },
        authority: { state: 'unknown', detail: 'connect ECONNREFUSED', retryable: true },
      })
    )
    const read = captureStdout()

    await cmdTargetLocate([SCOPE])
    const out = read()

    expect(out).toContain('UNKNOWN')
    expect(out).not.toMatch(/authority:\s+unbound/)
  })
})

describe('hrc doctor', () => {
  function report(overrides: Partial<LocateBindingsReport['scan']> = {}): LocateBindingsReport {
    return {
      localNodeId: 'max3',
      federationConfigured: true,
      gateMode: 'advisory',
      scan: { scanned: 1, skewed: [], unreadable: [], ...overrides },
    }
  }

  test('reports placement-skew ok when nothing is skewed', async () => {
    stubBindings(report())
    const read = captureStdout()

    await cmdDoctor([])
    const out = read()

    expect(out).toContain('placement-skew')
    expect(out).toContain('+ placement-skew')
  })

  test('skew is a WARNING, and exits 0 — the scope is still serving correctly', async () => {
    stubBindings(
      report({
        skewed: [
          {
            scopeRef: SCOPE,
            skew: {
              kind: 'pin-vs-binding',
              pinKey: 'hrc-runtime:T-06613',
              pinnedNodeId: 'mini',
              boundNodeId: 'max3',
              placementEpoch: 2,
              establishmentProvenance: 'default_home_node',
              detail: 'skewed',
            },
          },
        ],
      })
    )
    const read = captureStdout()

    await cmdDoctor([])
    const out = read()

    expect(out).toContain('~ placement-skew')
    expect(out).toContain('keeps summon authority')
    // The finding names the command that explains it.
    expect(out).toContain('hrc target locate')
  })

  test('--strict turns a skew warning into a nonzero exit', async () => {
    stubBindings(
      report({
        skewed: [
          {
            scopeRef: SCOPE,
            skew: {
              kind: 'pin-vs-binding',
              pinKey: 'k',
              pinnedNodeId: 'mini',
              boundNodeId: 'max3',
              placementEpoch: 1,
              establishmentProvenance: 'pin',
              detail: 'skewed',
            },
          },
        ],
      })
    )
    captureStdout()

    await expect(cmdDoctor(['--strict'])).rejects.toBeInstanceOf(CliStatusExit)
  })

  test('--json emits the check list', async () => {
    stubBindings(report())
    const read = captureStdout()

    await cmdDoctor(['--json'])
    const checks = JSON.parse(read()) as { name: string }[]

    expect(checks.map((check) => check.name)).toContain('placement-skew')
    expect(checks.map((check) => check.name)).toContain('node-identity')
  })
})

/**
 * Registration-layer coverage.
 *
 * The handler tests above call `cmdTargetLocate` directly, which is exactly how
 * `--fail-on-skew` shipped broken the first time: commander's camelCase opt key
 * has to be re-emitted as the KEBAB flag the handler greps for, and calling the
 * handler directly skips that translation entirely. These drive the real
 * program so the wiring is under test, not just the handler.
 */
describe('command registration wiring', () => {
  test('--fail-on-skew survives the commander -> legacy argv translation', async () => {
    stubLocate(
      baseLocation({
        skew: {
          kind: 'pin-vs-binding',
          pinKey: 'k',
          pinnedNodeId: 'mini',
          boundNodeId: 'max3',
          placementEpoch: 1,
          establishmentProvenance: 'pin',
          detail: 'skewed',
        },
      })
    )
    captureStdout()
    const { buildProgram } = await import('../cli/build-program.js')

    await expect(
      buildProgram().parseAsync(['target', 'locate', SCOPE, '--fail-on-skew'], { from: 'user' })
    ).rejects.toBeInstanceOf(CliStatusExit)
  })

  test('without --fail-on-skew the same skewed report exits 0', async () => {
    stubLocate(
      baseLocation({
        skew: {
          kind: 'pin-vs-binding',
          pinKey: 'k',
          pinnedNodeId: 'mini',
          boundNodeId: 'max3',
          placementEpoch: 1,
          establishmentProvenance: 'pin',
          detail: 'skewed',
        },
      })
    )
    const read = captureStdout()
    const { buildProgram } = await import('../cli/build-program.js')

    await buildProgram().parseAsync(['target', 'locate', SCOPE], { from: 'user' })

    expect(read()).toContain('!! SKEW')
  })

  test('doctor --strict survives the translation too', async () => {
    stubBindings({
      localNodeId: 'max3',
      federationConfigured: true,
      gateMode: 'advisory',
      scan: {
        scanned: 1,
        unreadable: [],
        skewed: [
          {
            scopeRef: SCOPE,
            skew: {
              kind: 'pin-vs-binding',
              pinKey: 'k',
              pinnedNodeId: 'mini',
              boundNodeId: 'max3',
              placementEpoch: 1,
              establishmentProvenance: 'pin',
              detail: 'skewed',
            },
          },
        ],
      },
    })
    captureStdout()
    const { buildProgram } = await import('../cli/build-program.js')

    await expect(
      buildProgram().parseAsync(['doctor', '--strict'], { from: 'user' })
    ).rejects.toBeInstanceOf(CliStatusExit)
  })
})
