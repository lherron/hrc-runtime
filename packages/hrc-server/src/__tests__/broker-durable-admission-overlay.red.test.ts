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
 * because the compiled claude-code-tmux BrokerExecutionProfile sets
 * expectedCapabilities.control.attachReplay === 'forbidden' (the pre-durable
 * default) while the durable broker advertises attachReplay:true. The profile
 * forbids the exact capability that restart-durability REQUIRES.
 *
 * The cody-approved fix is a ROUTE-SPECIFIC ADMISSION OVERLAY (NOT mutating the
 * frozen, hash-adjacent compiled profile): admitBrokerHello's per-route
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
 *                   attachReplay:true ADMITS *even if* the profile's
 *                   expectedCapabilities.control.attachReplay === 'forbidden'
 *                   (the route overlay WINS for the route HRC selected). A hello
 *                   that does NOT advertise attachReplay:true is REJECTED with a
 *                   `broker.capabilities.attachReplay` (required-missing) marker.
 *   - omitted/undefined → no overlay; the profile's own
 *                   expectedCapabilities.control.attachReplay (e.g. 'forbidden')
 *                   still applies, so accidental broker capability DRIFT outside
 *                   the durable route is STILL caught.
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
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import { admitBrokerHello } from '../broker/capabilities'

import { makeInteractiveTmuxProfile } from './broker-compile-fixtures'

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

// The LEGACY stdio route overlay: stdio/v1, NO control overlay → the profile's
// own 'forbidden' must still apply (capability-drift guard).
const LEGACY_STDIO_EXPECTED: ExpectedNegotiation = { protocolVersion: V1, transport: STDIO }

// admitBrokerHello takes (profile, hello, { protocolVersion, transport }) today;
// the optional `control` overlay is the pinned Phase-7 contract. The cast keeps
// this test compiling before the signature widens (bun runs without type-checking).
const admit = admitBrokerHello as unknown as (
  profile: BrokerExecutionProfile,
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
 * Clone the compiled interactive claude-code-tmux profile and inject
 * expectedCapabilities.control.attachReplay === 'forbidden' — the pre-durable
 * default that the REAL compiled profile carries and that triggers the live
 * `broker.capabilities.attachReplay.forbidden` rejection. We do NOT mutate the
 * fixture in place (the real profile is frozen/hash-adjacent).
 */
function forbiddenAttachReplayProfile(): BrokerExecutionProfile {
  const { profile } = makeInteractiveTmuxProfile()
  const base = profile as unknown as Record<string, unknown>
  const existing = (base.expectedCapabilities ?? {}) as Record<string, unknown>
  const existingControl = (existing.control ?? {}) as Record<string, unknown>
  return {
    ...base,
    expectedCapabilities: {
      ...existing,
      control: { ...existingControl, attachReplay: 'forbidden' },
    },
  } as unknown as BrokerExecutionProfile
}

describe('T-01816 Phase 7 — route-specific durable admission overlay (attachReplay)', () => {
  it('#1 ADMIT-ON-DURABLE: forbidden-profile + attachReplay:true hello ADMITS on the durable route (RED today)', () => {
    const profile = forbiddenAttachReplayProfile()
    const hello = makeHello({
      protocolVersion: V2,
      transports: [STDIO, UNIX],
      attachReplay: true,
      driverKind: 'claude-code-tmux',
    })
    const result = admit(profile, hello, DURABLE_EXPECTED)
    // Today: the profile's control.attachReplay==='forbidden' fires against the
    // broker's attachReplay:true →
    //   missing: ['broker.capabilities.attachReplay.forbidden'], ok:false.
    // After the overlay lands: control.attachReplay:'required' WINS for this
    // route, so the forbidden rule is suppressed and admission is clean.
    expect(result.missing).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('#2 REJECT-ON-LEGACY: the SAME forbidden-profile + attachReplay drift is STILL rejected with no durable overlay (guard)', () => {
    const profile = forbiddenAttachReplayProfile()
    // A legacy stdio/v1 broker that ACCIDENTALLY advertises attachReplay:true —
    // exactly the capability DRIFT the profile 'forbidden' exists to catch.
    const hello = makeHello({
      protocolVersion: V1,
      transports: [STDIO],
      attachReplay: true,
      driverKind: 'claude-code-tmux',
    })
    const result = admit(profile, hello, LEGACY_STDIO_EXPECTED)
    // No durable overlay → the profile's 'forbidden' still applies → rejected.
    // The overlay MUST NOT leak outside the durable route. (Holds today + after.)
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('broker.capabilities.attachReplay.forbidden')
  })

  it('#3 DURABLE-REQUIRES: a durable hello WITHOUT attachReplay is REJECTED (required, not optional) (RED today)', () => {
    const profile = forbiddenAttachReplayProfile()
    const hello = makeHello({
      protocolVersion: V2,
      transports: [STDIO, UNIX],
      attachReplay: false,
      driverKind: 'claude-code-tmux',
    })
    const result = admit(profile, hello, DURABLE_EXPECTED)
    // Today: with attachReplay:false the profile's 'forbidden' check does NOT
    // fire and there is NO required-check, so the hello is wrongly ADMITTED.
    // After the overlay lands: control.attachReplay:'required' rejects a hello
    // that does not advertise attachReplay → `broker.capabilities.attachReplay`.
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('broker.capabilities.attachReplay')
  })
})
