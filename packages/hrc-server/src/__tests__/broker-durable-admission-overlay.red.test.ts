/**
 * RED tests (T-01816 / T-01801 Phase 7) — route-specific durable admission
 * overlay for broker control.attachReplay.
 *
 * Governing task: T-01816 (parent T-01801; architect fix-shape cody DM #4973,
 * coordinator finding C-03123). The durable Unix transport is PROVEN against a
 * real harness-broker (connect-unix + harness-broker/0.2 hello advertising
 * attachReplay:true), but the live interactive START is rejected at pre-start
 * admission with:
 *
 *     missing: ["broker.capabilities.attachReplay.forbidden"]
 *
 * because an older controller fixture carried a v1 profile compatibility rule
 * that forbade attachReplay while the durable broker advertised it. That
 * compatibility input is retired: v2 admission receives the selected driver
 * plus the producer-declared hosting requirement.
 *
 * The cody-approved fix is a ROUTE-SPECIFIC ADMISSION OVERLAY (NOT mutating the
 * frozen producer execution): admitBrokerHello's per-route
 * `expected` argument (today `{ protocolVersion, transport }`, T-01810 Phase 1)
 * gains an OPTIONAL expected broker CONTROL-capabilities overlay. The durable
 * route passes `control: { attachReplay: 'required' }`; the legacy stdio route
 * passes nothing and still honors the profile's 'forbidden'.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * EXPECTED OVERLAY CONTRACT (assert this exact shape so the implementer matches)
 *
 *   admitBrokerHello(profile, hello, expected?) where
 *     expected?: {
 *       protocolVersion: BrokerProtocolVersion
 *       transport: BrokerTransportKind
 *       control?: { attachReplay?: 'required' | 'optional' | 'forbidden' }   // NEW
 *     }
 *
 *   Overlay semantics for control.attachReplay:
 *   - 'required'  → the route REQUIRES attachReplay. A hello advertising
 *                   attachReplay:true ADMITS; one that does not is REJECTED with
 *                   `broker.capabilities.attachReplay`.
 *   - omitted/undefined → this start declares no durable attach/replay
 *                   requirement. HRC does not reconstruct a retired profile
 *                   compatibility rule.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * These tests pin the Phase-7 contract and are EXPECTED TO FAIL at HEAD:
 *   #1 ADMIT-ON-DURABLE  — RED today: rejected with attachReplay.forbidden.
 *   #2 REJECT-ON-LEGACY  — guard (passes today + after) so the overlay can't leak.
 *   #3 DURABLE-REQUIRES  — RED today: a durable hello WITHOUT attachReplay is
 *                          wrongly ADMITTED because no required-check exists yet.
 *
 * Tests only — no production code is implemented here; they must be RED now.
 */
import { describe, expect, it } from 'bun:test'

import type {
  BrokerHelloResponse,
  BrokerProtocolVersion,
  BrokerTransportKind,
} from 'spaces-harness-broker-protocol'

import { admitBrokerHello } from '../broker/capabilities'

const STDIO: BrokerTransportKind = 'stdio-jsonrpc-ndjson'
const UNIX: BrokerTransportKind = 'unix-jsonrpc-ndjson'
const V1: BrokerProtocolVersion = 'harness-broker/0.1'
const V2: BrokerProtocolVersion = 'harness-broker/0.2'

/**
 * The per-route expectation the Phase-7 admitBrokerHello() must consume. Extends
 * the Phase-1 `{ protocolVersion, transport }` shape with an OPTIONAL expected
 * broker control-capabilities overlay.
 */
type ExpectedControlOverlay = { attachReplay?: 'required' | 'optional' | 'forbidden' }
type ExpectedNegotiation = {
  protocolVersion: BrokerProtocolVersion
  transport: BrokerTransportKind
  control?: ExpectedControlOverlay
}

// The DURABLE-IPC route overlay: unix/v2 AND attachReplay REQUIRED (not optional
// — restart durability acceptance cannot hold without attach/replay).
const DURABLE_EXPECTED: ExpectedNegotiation = {
  protocolVersion: V2,
  transport: UNIX,
  control: { attachReplay: 'required' },
}

// The legacy stdio expectation carries no durable attach/replay requirement.
const LEGACY_STDIO_EXPECTED: ExpectedNegotiation = { protocolVersion: V1, transport: STDIO }

const admit = admitBrokerHello as unknown as (
  driver: string,
  hello: BrokerHelloResponse,
  expected?: ExpectedNegotiation
) => ReturnType<typeof admitBrokerHello>

/**
 * Build a broker hello with an explicitly controlled attachReplay capability and
 * a single AVAILABLE matching driver carrying no deep `capabilities` (so the
 * pre-start driver-capability check short-circuits and we isolate the
 * attachReplay overlay).
 */
function makeHello(opts: {
  protocolVersion: BrokerProtocolVersion
  transports: BrokerTransportKind[]
  attachReplay: boolean
  driverKind: string
}): BrokerHelloResponse {
  return {
    brokerInfo: { name: 'harness-broker', version: '0.0.0-test' },
    protocolVersion: opts.protocolVersion,
    capabilities: {
      multiInvocation: false,
      transports: opts.transports,
      eventNotifications: true,
      brokerToClientRequests: true,
      attachReplay: opts.attachReplay,
    },
    drivers: [{ kind: opts.driverKind, version: '1', available: true }],
  }
}

/**
 * v2 broker admission receives only the producer-selected driver and the
 * execution hosting requirement. A v1 profile's expectedCapabilities is not an
 * HRC compatibility input and must not be reconstructed in these tests.
 */
const DRIVER = 'claude-code-tmux'

describe('T-01816 Phase 7 — route-specific durable admission overlay (attachReplay)', () => {
  it('#1 ADMIT-ON-DURABLE: attachReplay:true hello ADMITS on the durable route', () => {
    const hello = makeHello({
      protocolVersion: V2,
      transports: [STDIO, UNIX],
      attachReplay: true,
      driverKind: 'claude-code-tmux',
    })
    const result = admit(DRIVER, hello, DURABLE_EXPECTED)
    expect(result.missing).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('#2 LEGACY-HAS-NO-V1-PROFILE-AUTHORITY: attachReplay is not refused without a durable requirement', () => {
    const hello = makeHello({
      protocolVersion: V1,
      transports: [STDIO],
      attachReplay: true,
      driverKind: 'claude-code-tmux',
    })
    const result = admit(DRIVER, hello, LEGACY_STDIO_EXPECTED)
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('#3 DURABLE-REQUIRES: a durable hello WITHOUT attachReplay is REJECTED (required, not optional) (RED today)', () => {
    const hello = makeHello({
      protocolVersion: V2,
      transports: [STDIO, UNIX],
      attachReplay: false,
      driverKind: 'claude-code-tmux',
    })
    const result = admit(DRIVER, hello, DURABLE_EXPECTED)
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('broker.capabilities.attachReplay')
  })
})
