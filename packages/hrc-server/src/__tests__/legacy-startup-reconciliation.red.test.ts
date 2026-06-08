/**
 * T-01760 — RED acceptance tests (smokey). The LAST task of the T-01753
 * harness-broker cutover (proposal item #6).
 *
 * Wave B (T-01755/56/58, committed dfdca4a) made dispatch/ensure/attach
 * broker-only and fail-closed: no NEW legacy non-broker runtime is created or
 * reused for a harness turn. T-01760 cleans up EXISTING state — on daemon
 * startup, legacy harness runtimes (controllerKind unset OR != 'harness-broker')
 * must be marked stale/terminated so they can never be reused for a harness
 * turn — WHILE preserving broker tmux LEASE runtimes and attach descriptors.
 *
 * This file pins the PURE decision at the heart of that startup pass: given the
 * (controllerKind / transport / status / broker-tmux-socket / attach-descriptor)
 * view of one persisted runtime, decide whether the legacy sweep STALEs it,
 * PRESERVEs it (deferring to the dedicated broker reconciliation pass), or
 * no-ops (already unavailable → idempotent).
 *
 * These are PURE/INJECTABLE seam tests. They do NOT enumerate the runtime store,
 * restart HRC, kill a tmux lease, or run a live turn — that is the impl agent's
 * installed-binary smoke (seed a legacy runtime → restart daemon → confirm it
 * staled and the broker lease + attach descriptor survived).
 *
 * ── Seam contract the impl agent must implement in ../index
 *    (exported, pure, no live deps — the startup pass maps each runtime to this
 *     view and acts on the disposition):
 *
 *   // The minimal view the legacy sweep consults. Derived from HrcRuntimeSnapshot:
 *   //   controllerKind / transport / status  → direct snapshot fields
 *   //   brokerTmuxSocketPath  = getBrokerRuntimeTmuxSocketPath(runtime)
 *   //       (PRESENCE only — NEVER compared against the legacy default
 *   //        <runtimeRoot>/tmux.sock; broker leases live under <runtimeRoot>/btmux/)
 *   //   hasAttachDescriptor   = whether an attach descriptor persists for it
 *   export type LegacyStartupRuntimeView = {
 *     controllerKind: HrcRuntimeControllerKind | undefined
 *     transport: string
 *     status: string
 *     brokerTmuxSocketPath: string | undefined
 *     hasAttachDescriptor: boolean
 *   }
 *
 *   export type LegacyStartupReconciliationDecision =
 *     // controllerKind unset OR != 'harness-broker' on a still-reusable runtime:
 *     // mark stale/terminated so it is never reused for a harness turn.
 *     | { disposition: 'stale'; reason: 'legacy_no_controller_kind' | 'legacy_non_broker_controller_kind' }
 *     // A harness-broker runtime: leave it for the dedicated broker
 *     // reconciliation pass (lease re-associate / attach survival). The legacy
 *     // sweep NEVER touches it.
 *     | { disposition: 'preserve'; reason: 'broker_tmux_lease' | 'broker_attach_descriptor' | 'broker_runtime' }
 *     // Already terminated/dead/stale (isRuntimeUnavailableStatus): idempotent no-op.
 *     | { disposition: 'noop' }
 *
 *   export function decideLegacyRuntimeStartupDisposition(
 *     view: LegacyStartupRuntimeView
 *   ): LegacyStartupReconciliationDecision
 *
 * ── Decision semantics (evaluated in THIS order):
 *
 *   1. status is unavailable (isRuntimeUnavailableStatus: terminated/dead/stale)
 *      → { disposition: 'noop' }. Idempotent: a second startup pass over an
 *      already-staled runtime is a no-op.
 *   2. controllerKind === 'harness-broker' → { disposition: 'preserve' }.
 *      reason: socket present → 'broker_tmux_lease';
 *              else attach descriptor → 'broker_attach_descriptor';
 *              else → 'broker_runtime'.
 *      The path VALUE is never inspected for the stale/preserve decision — only
 *      presence. (LANDMINE below.)
 *   3. otherwise (controllerKind unset, or any non-broker kind:
 *      terminal / embedded-sdk / legacy-exec / command-process / unknown)
 *      → { disposition: 'stale' }.
 *      reason: controllerKind === undefined → 'legacy_no_controller_kind';
 *              else → 'legacy_non_broker_controller_kind'.
 *
 * ── LANDMINE this file encodes (cody, C-03008):
 *   A harness-broker TMUX runtime whose socket path is NOT the legacy default
 *   tmux socket (it lives under <runtimeRoot>/btmux/) must STILL be PRESERVED.
 *   The sweep keys off broker socket PRESENCE / controllerKind, NEVER off the old
 *   default socket path. We prove this by varying the socket path across a btmux
 *   lease path, the legacy default path string, and an arbitrary path — ALL
 *   preserve when controllerKind === 'harness-broker'. Conversely, a NON-broker
 *   runtime sitting on a btmux-looking socket is STILL staled (a socket does not
 *   rescue a missing/wrong controllerKind).
 */
import { describe, expect, it } from 'bun:test'

import * as hrc from '../index'

type HrcRuntimeControllerKind = string

type LegacyStartupRuntimeView = {
  controllerKind: HrcRuntimeControllerKind | undefined
  transport: string
  status: string
  brokerTmuxSocketPath: string | undefined
  hasAttachDescriptor: boolean
}

type LegacyStartupReconciliationDecision =
  | {
      disposition: 'stale'
      reason: 'legacy_no_controller_kind' | 'legacy_non_broker_controller_kind'
    }
  | {
      disposition: 'preserve'
      reason: 'broker_tmux_lease' | 'broker_attach_descriptor' | 'broker_runtime'
    }
  | { disposition: 'noop' }

// Representative socket paths. The legacy default is <runtimeRoot>/tmux.sock;
// broker leases live under <runtimeRoot>/btmux/. The decision must NOT compare
// against the legacy default — it keys off presence only.
const RUNTIME_ROOT = '/Users/lherron/praesidium/var/run/hrc'
const LEGACY_DEFAULT_TMUX_SOCKET = `${RUNTIME_ROOT}/tmux.sock`
const BROKER_LEASE_SOCKET = `${RUNTIME_ROOT}/btmux/hrc-claude-code-tmux-rt0001.sock`
const ARBITRARY_SOCKET = '/tmp/some-other-place/lease.sock'

// Typed handle to the seam under test (undefined until the impl agent adds it).
const decideLegacyRuntimeStartupDisposition = (
  hrc as unknown as {
    decideLegacyRuntimeStartupDisposition?: (
      view: LegacyStartupRuntimeView
    ) => LegacyStartupReconciliationDecision
  }
).decideLegacyRuntimeStartupDisposition

function view(overrides: Partial<LegacyStartupRuntimeView> = {}): LegacyStartupRuntimeView {
  return {
    controllerKind: 'harness-broker',
    transport: 'tmux',
    status: 'running',
    brokerTmuxSocketPath: BROKER_LEASE_SOCKET,
    hasAttachDescriptor: false,
    ...overrides,
  }
}

describe('T-01760 startup sweep seam — export exists', () => {
  it('exports decideLegacyRuntimeStartupDisposition', () => {
    expect(typeof decideLegacyRuntimeStartupDisposition).toBe('function')
  })
})

describe('decideLegacyRuntimeStartupDisposition — legacy controllerKind unset → STALE', () => {
  it('controllerKind undefined + tmux transport → stale (legacy_no_controller_kind)', () => {
    const decision = decideLegacyRuntimeStartupDisposition!(
      view({ controllerKind: undefined, brokerTmuxSocketPath: undefined })
    )
    expect(decision).toEqual({ disposition: 'stale', reason: 'legacy_no_controller_kind' })
  })

  it('controllerKind undefined + ghostty transport → stale (legacy_no_controller_kind)', () => {
    const decision = decideLegacyRuntimeStartupDisposition!(
      view({ controllerKind: undefined, transport: 'ghostty', brokerTmuxSocketPath: undefined })
    )
    expect(decision).toEqual({ disposition: 'stale', reason: 'legacy_no_controller_kind' })
  })

  it('controllerKind undefined + headless transport → stale (legacy_no_controller_kind)', () => {
    const decision = decideLegacyRuntimeStartupDisposition!(
      view({ controllerKind: undefined, transport: 'headless', brokerTmuxSocketPath: undefined })
    )
    expect(decision).toEqual({ disposition: 'stale', reason: 'legacy_no_controller_kind' })
  })
})

describe('decideLegacyRuntimeStartupDisposition — non-broker controllerKind → STALE', () => {
  const nonBrokerKinds = ['terminal', 'embedded-sdk', 'legacy-exec', 'command-process', 'sdk']
  for (const controllerKind of nonBrokerKinds) {
    it(`controllerKind=${controllerKind} → stale (legacy_non_broker_controller_kind)`, () => {
      const decision = decideLegacyRuntimeStartupDisposition!(
        view({ controllerKind, brokerTmuxSocketPath: undefined })
      )
      expect(decision).toEqual({
        disposition: 'stale',
        reason: 'legacy_non_broker_controller_kind',
      })
    })
  }

  it('unknown controllerKind string → stale (legacy_non_broker_controller_kind)', () => {
    const decision = decideLegacyRuntimeStartupDisposition!(
      view({ controllerKind: 'frobnicate', brokerTmuxSocketPath: undefined })
    )
    expect(decision).toEqual({
      disposition: 'stale',
      reason: 'legacy_non_broker_controller_kind',
    })
  })
})

describe('decideLegacyRuntimeStartupDisposition — harness-broker runtimes → PRESERVE', () => {
  it('broker tmux runtime with a present lease socket → preserve (broker_tmux_lease)', () => {
    const decision = decideLegacyRuntimeStartupDisposition!(
      view({
        controllerKind: 'harness-broker',
        transport: 'tmux',
        brokerTmuxSocketPath: BROKER_LEASE_SOCKET,
      })
    )
    expect(decision).toEqual({ disposition: 'preserve', reason: 'broker_tmux_lease' })
  })

  it('broker runtime with a valid attach descriptor (no socket) → preserve (broker_attach_descriptor)', () => {
    const decision = decideLegacyRuntimeStartupDisposition!(
      view({
        controllerKind: 'harness-broker',
        transport: 'headless',
        brokerTmuxSocketPath: undefined,
        hasAttachDescriptor: true,
      })
    )
    expect(decision).toEqual({ disposition: 'preserve', reason: 'broker_attach_descriptor' })
  })

  it('broker runtime with neither socket nor attach descriptor → preserve (broker_runtime) — legacy sweep never touches a broker runtime', () => {
    const decision = decideLegacyRuntimeStartupDisposition!(
      view({
        controllerKind: 'harness-broker',
        transport: 'headless',
        brokerTmuxSocketPath: undefined,
        hasAttachDescriptor: false,
      })
    )
    expect(decision).toEqual({ disposition: 'preserve', reason: 'broker_runtime' })
  })
})

describe('decideLegacyRuntimeStartupDisposition — LANDMINE (C-03008): broker tmux lease preserved regardless of socket PATH', () => {
  // The sweep must key off broker socket PRESENCE / controllerKind, NEVER the old
  // default tmux socket path. A harness-broker tmux runtime is PRESERVED whether
  // its socket is a btmux lease, the legacy default path string, or anything else.
  const socketPaths = [
    { name: 'btmux lease socket (the real shape)', path: BROKER_LEASE_SOCKET },
    { name: 'legacy default tmux.sock path string', path: LEGACY_DEFAULT_TMUX_SOCKET },
    { name: 'arbitrary socket path', path: ARBITRARY_SOCKET },
  ]
  for (const { name, path } of socketPaths) {
    it(`harness-broker tmux runtime on ${name} → preserve (NOT staled for being off the default)`, () => {
      const decision = decideLegacyRuntimeStartupDisposition!(
        view({
          controllerKind: 'harness-broker',
          transport: 'tmux',
          brokerTmuxSocketPath: path,
        })
      )
      expect(decision.disposition).toBe('preserve')
      // Hard invariant: a broker tmux lease is NEVER staled by the legacy sweep.
      expect(decision.disposition).not.toBe('stale')
    })
  }

  it('a NON-broker runtime sitting on a btmux-looking socket is STILL staled (a socket does not rescue a missing controllerKind)', () => {
    const decision = decideLegacyRuntimeStartupDisposition!(
      view({
        controllerKind: undefined,
        transport: 'tmux',
        brokerTmuxSocketPath: BROKER_LEASE_SOCKET,
      })
    )
    expect(decision.disposition).toBe('stale')
  })
})

describe('decideLegacyRuntimeStartupDisposition — already-unavailable runtimes → NOOP (idempotent)', () => {
  for (const status of ['terminated', 'dead', 'stale']) {
    it(`status=${status} → noop, even for a legacy controllerKind (already not reusable)`, () => {
      const decision = decideLegacyRuntimeStartupDisposition!(
        view({ controllerKind: undefined, status, brokerTmuxSocketPath: undefined })
      )
      expect(decision).toEqual({ disposition: 'noop' })
    })

    it(`status=${status} → noop for a harness-broker runtime too`, () => {
      const decision = decideLegacyRuntimeStartupDisposition!(
        view({ controllerKind: 'harness-broker', status })
      )
      expect(decision).toEqual({ disposition: 'noop' })
    })
  }
})

describe('decideLegacyRuntimeStartupDisposition — structural: a broker runtime is NEVER staled & a legacy runtime is NEVER preserved', () => {
  const liveStatuses = ['running', 'starting', 'ready', 'idle']
  for (const status of liveStatuses) {
    it(`live (status=${status}) harness-broker tmux lease is never staled`, () => {
      const decision = decideLegacyRuntimeStartupDisposition!(
        view({
          controllerKind: 'harness-broker',
          status,
          brokerTmuxSocketPath: BROKER_LEASE_SOCKET,
        })
      )
      expect(decision.disposition).not.toBe('stale')
    })

    it(`live (status=${status}) legacy (controllerKind unset) runtime is never preserved`, () => {
      const decision = decideLegacyRuntimeStartupDisposition!(
        view({ controllerKind: undefined, status, brokerTmuxSocketPath: undefined })
      )
      expect(decision.disposition).not.toBe('preserve')
      expect(decision.disposition).toBe('stale')
    })
  }
})
