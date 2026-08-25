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

import type {
  FederationOutboxDeliveryRecord,
  FederationRebindResult,
  LocateBindingsReport,
  ScopeLocation,
} from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import {
  cmdDoctor,
  cmdFederationOutboxCancel,
  cmdFederationOutboxDrop,
  cmdFederationOutboxList,
  cmdFederationOutboxReplay,
  cmdFederationRebind,
} from '../cli/handlers-federation.js'
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

const _boundRecord = {
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
  const originalOutbox = HrcClient.prototype.listFederationOutbox
  HrcClient.prototype.listPlacementBindings = async () => report
  HrcClient.prototype.listFederationOutbox = async () => []
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
        protocolVersion: '1.0',
      },
      {
        nodeId: 'svc',
        state: 'unreachable',
        checkedAt: '2026-07-20T00:00:00.000Z',
        latencyMs: 1500,
        detail: 'probe timed out',
      },
    ],
  })) as typeof HrcClient.prototype.getStatus
  restores.push(() => {
    HrcClient.prototype.listPlacementBindings = originalBindings
    HrcClient.prototype.getStatus = originalStatus
    HrcClient.prototype.listFederationOutbox = originalOutbox
  })
}

function outboxDelivery(
  overrides: Partial<FederationOutboxDeliveryRecord> = {}
): FederationOutboxDeliveryRecord {
  return {
    deliveryId: 'delivery-1',
    messageId: 'msg-11111111-1111-4111-8111-111111111111',
    peerNodeId: 'lab',
    envelope: {
      protocolVersion: '1.0',
      messageId: 'msg-11111111-1111-4111-8111-111111111111',
      kind: 'dm',
      phase: 'request',
      from: { kind: 'session', sessionRef: SCOPE },
      to: { kind: 'session', sessionRef: `${SCOPE}:role:peer` },
      body: 'sleep envelope',
      rootMessageId: 'msg-11111111-1111-4111-8111-111111111111',
      expected: { homeNodeId: 'lab', placementEpoch: 1 },
    },
    state: 'dead_letter',
    totalAttempts: 5,
    cycleAttempts: 5,
    replayCount: 0,
    retryWindowStartedAt: '2026-07-01T00:00:00.000Z',
    lastAttemptAt: '2026-07-15T00:00:00.000Z',
    deadLetteredAt: '2026-07-15T00:00:00.000Z',
    lastErrorCode: 'peer_unreachable',
    lastErrorMessage: 'connection refused',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  }
}

function stubOutbox(deliveries: FederationOutboxDeliveryRecord[]): {
  replayed: string[]
  replayedPeers: string[]
  dropped: string[]
  cancelled: string[]
} {
  const originalList = HrcClient.prototype.listFederationOutbox
  const originalReplay = HrcClient.prototype.replayFederationOutbox
  const originalReplayPeer = HrcClient.prototype.replayFederationOutboxPeer
  const originalDrop = HrcClient.prototype.dropFederationOutbox
  const originalCancel = HrcClient.prototype.cancelFederationOutbox
  const calls = {
    replayed: [] as string[],
    replayedPeers: [] as string[],
    dropped: [] as string[],
    cancelled: [] as string[],
  }
  HrcClient.prototype.listFederationOutbox = async () => deliveries
  HrcClient.prototype.replayFederationOutbox = async (deliveryId) => {
    calls.replayed.push(deliveryId)
    return outboxDelivery({ deliveryId, state: 'pending', replayCount: 1 })
  }
  HrcClient.prototype.replayFederationOutboxPeer = async (peerNodeId) => {
    calls.replayedPeers.push(peerNodeId)
    return deliveries.filter(
      (delivery) => delivery.peerNodeId === peerNodeId && delivery.state === 'dead_letter'
    )
  }
  HrcClient.prototype.dropFederationOutbox = async (deliveryId) => {
    calls.dropped.push(deliveryId)
    return outboxDelivery({ deliveryId })
  }
  HrcClient.prototype.cancelFederationOutbox = async (deliveryId) => {
    calls.cancelled.push(deliveryId)
    return outboxDelivery({
      deliveryId,
      state: 'dead_letter',
      lastErrorCode: 'operator_cancelled',
    })
  }
  restores.push(() => {
    HrcClient.prototype.listFederationOutbox = originalList
    HrcClient.prototype.replayFederationOutbox = originalReplay
    HrcClient.prototype.replayFederationOutboxPeer = originalReplayPeer
    HrcClient.prototype.dropFederationOutbox = originalDrop
    HrcClient.prototype.cancelFederationOutbox = originalCancel
  })
  return calls
}

function stubRebind(): { calls: string[] } {
  const originalRevoke = HrcClient.prototype.revokeFederationRebind
  const originalCas = HrcClient.prototype.compareAndSwapFederationRebind
  const originalActivate = HrcClient.prototype.activateFederationRebind
  const calls: string[] = []
  const response = (step: 'revoke' | 'cas' | 'activate'): FederationRebindResult => ({
    step,
    ok: true,
    outcome: step === 'revoke' ? 'revoked' : step === 'cas' ? 'registry-updated' : 'activated',
    state:
      step === 'revoke'
        ? 'revoked-nowhere'
        : step === 'cas'
          ? 'registry-moved-activation-pending'
          : 'active-new-home',
    retryable: step !== 'activate',
    detail: `${step} complete`,
    request: {
      scopeRef: SCOPE,
      expectedHomeNodeId: 'svc',
      expectedPlacementEpoch: 1,
      newHomeNodeId: 'lab',
    },
  })
  HrcClient.prototype.revokeFederationRebind = async (request) => {
    calls.push(`revoke:${request.expectedHomeNodeId}@${request.expectedPlacementEpoch}`)
    return response('revoke')
  }
  HrcClient.prototype.compareAndSwapFederationRebind = async () => {
    calls.push('cas')
    return response('cas')
  }
  HrcClient.prototype.activateFederationRebind = async () => {
    calls.push('activate')
    return response('activate')
  }
  restores.push(() => {
    HrcClient.prototype.revokeFederationRebind = originalRevoke
    HrcClient.prototype.compareAndSwapFederationRebind = originalCas
    HrcClient.prototype.activateFederationRebind = originalActivate
  })
  return { calls }
}

describe('hrc federation outbox', () => {
  test('human list groups by peer and makes age plus last error visible', async () => {
    stubOutbox([
      outboxDelivery(),
      outboxDelivery({
        deliveryId: 'delivery-2',
        peerNodeId: 'max3',
        state: 'peer_unreachable',
        deadLetteredAt: undefined,
      }),
    ])
    const read = captureStdout()

    await cmdFederationOutboxList([])
    const out = read()

    expect(out).toContain('peer lab: 1')
    expect(out).toContain('peer max3: 1')
    expect(out).toContain('age=')
    expect(out).toContain('last-error=peer_unreachable: connection refused')
  })

  test('single and peer-wide replay use distinct typed client operations', async () => {
    const calls = stubOutbox([outboxDelivery()])
    captureStdout()

    await cmdFederationOutboxReplay(['delivery-1'])
    await cmdFederationOutboxReplay(['--peer', 'lab', '--all'])

    expect(calls.replayed).toEqual(['delivery-1'])
    expect(calls.replayedPeers).toEqual(['lab'])
  })

  test('drop requires explicit confirmation before the daemon is called', async () => {
    const calls = stubOutbox([outboxDelivery()])
    captureStdout()

    await expect(cmdFederationOutboxDrop(['delivery-1'])).rejects.toThrow('--yes')
    expect(calls.dropped).toEqual([])

    await cmdFederationOutboxDrop(['delivery-1', '--yes'])
    expect(calls.dropped).toEqual(['delivery-1'])
  })

  test('cancel uses the engine-owned recoverable terminal transition', async () => {
    const calls = stubOutbox([outboxDelivery({ state: 'retry_scheduled' })])
    const read = captureStdout()

    await cmdFederationOutboxCancel(['delivery-1'])

    expect(calls.cancelled).toEqual(['delivery-1'])
    expect(read()).toContain('operator_cancelled')
  })
})

describe('hrc federation rebind', () => {
  const flags = [SCOPE, '--expected-home', 'svc', '--expected-epoch', '1', '--new-home', 'lab']

  test('the three explicit steps call distinct typed SDK operations', async () => {
    const { calls } = stubRebind()
    const read = captureStdout()

    await cmdFederationRebind('revoke', flags)
    await cmdFederationRebind('cas', flags)
    await cmdFederationRebind('activate', flags)

    expect(calls).toEqual(['revoke:svc@1', 'cas', 'activate'])
    expect(read()).toContain('OK REVOKE revoked: revoked-nowhere')
    expect(read()).toContain('svc@1 -> lab@2')
  })

  test('a visible refused result prints before returning exit 1', async () => {
    const original = HrcClient.prototype.revokeFederationRebind
    HrcClient.prototype.revokeFederationRebind = async (request) => ({
      step: 'revoke',
      ok: false,
      outcome: 'live-runtime-present',
      state: 'old-home-live',
      retryable: true,
      detail: 'drain first',
      request,
      liveRuntimeIds: ['runtime-1'],
    })
    restores.push(() => {
      HrcClient.prototype.revokeFederationRebind = original
    })
    const read = captureStdout()

    await expect(cmdFederationRebind('revoke', flags)).rejects.toBeInstanceOf(CliStatusExit)
    expect(read()).toContain('REFUSED REVOKE live-runtime-present: old-home-live')
    expect(read()).toContain('live runtime: runtime-1')
  })

  test('refuses an old epoch that cannot be incremented safely', async () => {
    await expect(
      cmdFederationRebind('cas', [
        SCOPE,
        '--expected-home',
        'svc',
        '--expected-epoch',
        String(Number.MAX_SAFE_INTEGER),
        '--new-home',
        'lab',
      ])
    ).rejects.toThrow('room for E+1')
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
    expect(out).toContain('+ federation-outbox')
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

  test('renders an external-registration default_home_node disagreement', async () => {
    stubBindings(
      report({
        skewed: [
          {
            scopeRef: SCOPE,
            skew: {
              kind: 'default-home-vs-binding',
              defaultHomeNodeId: 'svc',
              boundNodeId: 'max3',
              placementEpoch: 2,
              establishmentProvenance: 'explicit_local',
              detail: 'skewed',
            },
          },
        ],
      })
    )
    const read = captureStdout()

    await cmdDoctor([])

    expect(read()).toContain('default_home_node = svc')
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
    expect(checks.map((check) => check.name)).toContain('federation-peer:lab')
    expect(checks.map((check) => check.name)).toContain('federation-peer:svc')
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
  test('rebind step flags survive the commander -> typed SDK translation', async () => {
    const { calls } = stubRebind()
    captureStdout()
    const { buildProgram } = await import('../cli/build-program.js')

    await buildProgram().parseAsync(
      [
        'federation',
        'rebind',
        'revoke',
        SCOPE,
        '--expected-home',
        'svc',
        '--expected-epoch',
        '1',
        '--new-home',
        'lab',
      ],
      { from: 'user' }
    )

    expect(calls).toEqual(['revoke:svc@1'])
  })

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
