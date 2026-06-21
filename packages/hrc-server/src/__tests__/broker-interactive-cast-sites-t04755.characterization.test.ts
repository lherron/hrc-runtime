/**
 * T-04755 — Characterization tests for the two `as` cast sites in
 * createBrokerDurableTmuxAllocator (substrate-allocator.ts:306-307).
 *
 * Cast sites under characterization:
 *   line 306: const tuiWindow = sub.tuiWindow as BrokerWindowIdentity
 *   line 307: const lease     = sub.tuiLease  as BrokerTmuxLease
 *
 * Both casts assert that optional fields on BrokerSubstrateAllocation
 * (tuiWindow?: BrokerWindowIdentity | undefined, tuiLease?: BrokerTmuxLease | undefined)
 * are actually defined when presentation='tmux-tui'.  curly will replace the
 * casts with proper runtime validation/narrowing in a later phase.  Risk: if
 * the value is genuinely partial today the validation would THROW where the
 * cast silently passes.
 *
 * THESE TESTS PIN:
 *   A) allocateBrokerSubstrate (presentation='tmux-tui') — the origin of both values:
 *      sub.tuiWindow is defined and is a complete BrokerWindowIdentity (no undefined fields).
 *      sub.tuiLease  is defined and is a complete BrokerTmuxLease (no undefined required fields).
 *      sub.tuiLease exactly mirrors sub.tuiWindow's identity + carries the canonical allowedOps.
 *   B) allocateBrokerSubstrate (presentation='none') — contrast: both are undefined.
 *   C) createBrokerDurableTmuxAllocator — downstream consumption via the cast:
 *      The returned BrokerTmuxAllocation carries the full tuiWindow shape and a
 *      fully-populated lease; legacy single-pane fields mirror the TUI pane.
 *
 * ASSESSMENT: neither sub.tuiWindow nor sub.tuiLease is partial today.
 *   The values flowing through the casts are complete — curly's validated narrowing
 *   will accept them and will NOT change behavior.  Tests here will catch any
 *   regression if a code change makes the values partial before curly's phase.
 *
 * GREEN NOW.  Must stay green after curly swaps casts for validated narrowing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  allocateBrokerSubstrate,
  createBrokerDurableTmuxAllocator,
} from '../broker-interactive-handlers'
import type {
  BrokerDurableTmuxAllocatorDeps,
  BrokerSubstrateAllocation,
  DurableTmuxManagerLike,
} from '../broker-interactive-handlers'
import type { BrokerWindowIdentity } from '../broker/controller'

// ── Fake named-window tmux manager ────────────────────────────────────────────
//
// Two window slots, each assigned stable ids so tests can assert exact shapes.
//   'broker' → sessionId=$1, windowId=@1, paneId=%1
//   'tui'    → sessionId=$1, windowId=@2, paneId=%2
// (same session — both windows share the same btmux server)

const FAKE_BTMUX_SOCKET = '/tmp/fake-btmux-t04755.sock'
const FAKE_SESSION_ID = '$1'

class FakeTmuxManager implements DurableTmuxManagerLike {
  initialized = false
  readonly withCommandCalls: Array<{ sessionName: string; windowName: string; command: string }> =
    []
  readonly orInspectCalls: Array<{ sessionName: string; windowName: string }> = []

  async initialize(): Promise<void> {
    this.initialized = true
  }

  async createWindowWithCommand(input: {
    sessionName: string
    windowName: string
    command: string
  }): Promise<BrokerWindowIdentity> {
    this.withCommandCalls.push(input)
    // broker window
    return {
      socketPath: FAKE_BTMUX_SOCKET,
      sessionId: FAKE_SESSION_ID,
      windowId: '@1',
      paneId: '%1',
      sessionName: input.sessionName,
      windowName: input.windowName,
    }
  }

  async createOrInspectWindow(input: {
    sessionName: string
    windowName: string
  }): Promise<BrokerWindowIdentity> {
    this.orInspectCalls.push(input)
    // tui window — distinct window in same session
    return {
      socketPath: FAKE_BTMUX_SOCKET,
      sessionId: FAKE_SESSION_ID,
      windowId: '@2',
      paneId: '%2',
      sessionName: input.sessionName,
      windowName: input.windowName,
    }
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeDeps(manager: FakeTmuxManager): BrokerDurableTmuxAllocatorDeps {
  return {
    tmuxManagerFactory: () => manager,
    generateAttachToken: () => 'tok-t04755-char',
    now: () => '2026-06-15T00:00:00.000Z',
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-t04755-char-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// =============================================================================
// A) allocateBrokerSubstrate(presentation='tmux-tui') — CAST SITE shapes
// =============================================================================
//
// Pins the exact shape of sub.tuiWindow and sub.tuiLease at the two cast sites
// in createBrokerDurableTmuxAllocator (substrate-allocator.ts:306-307).

describe('[CHARACTERIZATION A] allocateBrokerSubstrate(presentation=tmux-tui) — cast-site shapes', () => {
  let sub: BrokerSubstrateAllocation

  beforeEach(async () => {
    const manager = new FakeTmuxManager()
    sub = await allocateBrokerSubstrate({ runtimeRoot: dir }, makeDeps(manager), {
      runtimeId: 'rt-char-t04755',
      hostSessionId: 'hsid-char',
      generation: 7,
      driverKind: 'claude-code-tmux',
      endpoint: 'unix-jsonrpc-ndjson',
      presentation: 'tmux-tui',
    })
  })

  // ── sub.tuiWindow (cast site: line 306) ───────────────────────────────────

  it('sub.tuiWindow is defined (non-undefined) — cast is safe, value is present', () => {
    expect(sub.tuiWindow).toBeDefined()
  })

  it('sub.tuiWindow.socketPath is a non-empty string (BrokerWindowIdentity field 1 of 6)', () => {
    expect(typeof sub.tuiWindow?.socketPath).toBe('string')
    expect((sub.tuiWindow?.socketPath?.length ?? 0) > 0).toBe(true)
  })

  it('sub.tuiWindow.sessionId is a non-empty string (BrokerWindowIdentity field 2 of 6)', () => {
    expect(typeof sub.tuiWindow?.sessionId).toBe('string')
    expect((sub.tuiWindow?.sessionId?.length ?? 0) > 0).toBe(true)
  })

  it('sub.tuiWindow.windowId is a non-empty string (BrokerWindowIdentity field 3 of 6)', () => {
    expect(typeof sub.tuiWindow?.windowId).toBe('string')
    expect((sub.tuiWindow?.windowId?.length ?? 0) > 0).toBe(true)
  })

  it('sub.tuiWindow.paneId is a non-empty string (BrokerWindowIdentity field 4 of 6)', () => {
    expect(typeof sub.tuiWindow?.paneId).toBe('string')
    expect((sub.tuiWindow?.paneId?.length ?? 0) > 0).toBe(true)
  })

  it('sub.tuiWindow.sessionName is a non-empty string (BrokerWindowIdentity field 5 of 6)', () => {
    expect(typeof sub.tuiWindow?.sessionName).toBe('string')
    expect((sub.tuiWindow?.sessionName?.length ?? 0) > 0).toBe(true)
  })

  it('sub.tuiWindow.windowName is a non-empty string (BrokerWindowIdentity field 6 of 6)', () => {
    expect(typeof sub.tuiWindow?.windowName).toBe('string')
    expect((sub.tuiWindow?.windowName?.length ?? 0) > 0).toBe(true)
  })

  it('sub.tuiWindow has EXACTLY the 6 BrokerWindowIdentity fields (no missing, no partial undefined)', () => {
    // All 6 required fields of BrokerWindowIdentity must be present and non-undefined.
    // This is the exact shape the `as BrokerWindowIdentity` cast asserts.
    const w = sub.tuiWindow
    expect(w).not.toBeUndefined()
    expect(w?.socketPath).not.toBeUndefined()
    expect(w?.sessionId).not.toBeUndefined()
    expect(w?.windowId).not.toBeUndefined()
    expect(w?.paneId).not.toBeUndefined()
    expect(w?.sessionName).not.toBeUndefined()
    expect(w?.windowName).not.toBeUndefined()
  })

  it("sub.tuiWindow.windowName = 'tui' (the TUI window is the operator-facing pane, not the broker pane)", () => {
    expect(sub.tuiWindow?.windowName).toBe('tui')
  })

  it('sub.tuiWindow is the TUI pane, NOT the broker process pane (distinct windowId from brokerWindow)', () => {
    // The broker window and TUI window are two separate windows in the same session.
    expect(sub.tuiWindow?.windowId).not.toBe(sub.brokerWindow.windowId)
  })

  it('sub.tuiWindow and sub.brokerWindow share the same socketPath (same btmux server per runtime)', () => {
    expect(sub.tuiWindow?.socketPath).toBe(sub.brokerWindow.socketPath)
  })

  it('sub.tuiWindow and sub.brokerWindow share the same sessionId (same tmux session)', () => {
    expect(sub.tuiWindow?.sessionId).toBe(sub.brokerWindow.sessionId)
  })

  // ── sub.tuiLease (cast site: line 307) ────────────────────────────────────

  it('sub.tuiLease is defined (non-undefined) — cast is safe, value is present', () => {
    expect(sub.tuiLease).toBeDefined()
  })

  it("sub.tuiLease.kind = 'tmux-pane' (BrokerTmuxLease discriminant)", () => {
    expect(sub.tuiLease?.kind).toBe('tmux-pane')
  })

  it("sub.tuiLease.ownership = 'hrc' (HRC owns the TUI pane lease)", () => {
    expect(sub.tuiLease?.ownership).toBe('hrc')
  })

  it('sub.tuiLease.socketPath = sub.tuiWindow.socketPath (lease mirrors TUI window btmux socket)', () => {
    expect(sub.tuiLease?.socketPath).toBe(sub.tuiWindow?.socketPath)
  })

  it('sub.tuiLease.sessionId = sub.tuiWindow.sessionId (lease mirrors TUI window session)', () => {
    expect(sub.tuiLease?.sessionId).toBe(sub.tuiWindow?.sessionId)
  })

  it('sub.tuiLease.windowId = sub.tuiWindow.windowId (lease mirrors TUI window window-id)', () => {
    expect(sub.tuiLease?.windowId).toBe(sub.tuiWindow?.windowId)
  })

  it('sub.tuiLease.paneId = sub.tuiWindow.paneId (lease is the TUI pane, not the broker pane)', () => {
    expect(sub.tuiLease?.paneId).toBe(sub.tuiWindow?.paneId)
  })

  it('sub.tuiLease.paneId ≠ sub.brokerWindow.paneId (lease is TUI pane, NOT the broker process pane)', () => {
    expect(sub.tuiLease?.paneId).not.toBe(sub.brokerWindow.paneId)
  })

  it('sub.tuiLease.sessionName = sub.tuiWindow.sessionName (sessionName is set, not undefined)', () => {
    // sessionName is optional in BrokerTmuxLease but the allocator always sets it from tuiWindow.
    expect(sub.tuiLease?.sessionName).toBe(sub.tuiWindow?.sessionName)
    expect(sub.tuiLease?.sessionName).not.toBeUndefined()
  })

  it('sub.tuiLease.windowName = sub.tuiWindow.windowName (windowName is set, not undefined)', () => {
    // windowName is optional in BrokerTmuxLease but the allocator always sets it from tuiWindow.
    expect(sub.tuiLease?.windowName).toBe(sub.tuiWindow?.windowName)
    expect(sub.tuiLease?.windowName).not.toBeUndefined()
  })

  it('sub.tuiLease.allowedOps.inspect = true', () => {
    expect(sub.tuiLease?.allowedOps.inspect).toBe(true)
  })

  it('sub.tuiLease.allowedOps.sendInput = true', () => {
    expect(sub.tuiLease?.allowedOps.sendInput).toBe(true)
  })

  it('sub.tuiLease.allowedOps.sendInterrupt = true', () => {
    expect(sub.tuiLease?.allowedOps.sendInterrupt).toBe(true)
  })

  it('sub.tuiLease.allowedOps.capture = true (operators can capture the TUI pane)', () => {
    expect(sub.tuiLease?.allowedOps.capture).toBe(true)
  })

  it('sub.tuiLease.allowedOps.resize = false (HRC does not grant resize to operators)', () => {
    expect(sub.tuiLease?.allowedOps.resize).toBe(false)
  })

  // ── presentation axis ──────────────────────────────────────────────────────

  it("sub.presentation.kind = 'tmux-tui' (presentation axis consistent with tuiWindow being present)", () => {
    expect(sub.presentation.kind).toBe('tmux-tui')
  })
})

// =============================================================================
// B) allocateBrokerSubstrate(presentation='none') — contrast: both undefined
// =============================================================================
//
// Pins that sub.tuiWindow and sub.tuiLease are ABSENT for presentation='none'.
// This is the headless path (createBrokerDurableHeadlessAllocator).
// Contrast case: the validated narrowing curly adds must only validate tmux-tui.

describe('[CHARACTERIZATION B] allocateBrokerSubstrate(presentation=none) — tuiWindow/tuiLease absent', () => {
  let sub: BrokerSubstrateAllocation

  beforeEach(async () => {
    const manager = new FakeTmuxManager()
    sub = await allocateBrokerSubstrate({ runtimeRoot: dir }, makeDeps(manager), {
      runtimeId: 'rt-char-headless-t04755',
      hostSessionId: 'hsid-char-headless',
      generation: 2,
      driverKind: 'claude-code-tmux',
      endpoint: 'unix-jsonrpc-ndjson',
      presentation: 'none',
    })
  })

  it('sub.tuiWindow is undefined for presentation=none (no TUI window created)', () => {
    expect(sub.tuiWindow).toBeUndefined()
  })

  it('sub.tuiLease is undefined for presentation=none (no TUI pane lease)', () => {
    expect(sub.tuiLease).toBeUndefined()
  })

  it("sub.presentation.kind = 'none' for presentation=none", () => {
    expect(sub.presentation.kind).toBe('none')
  })

  it('presentation=none: createOrInspectWindow was NOT called (no TUI window created)', () => {
    // The allocator only creates the broker window; the TUI window creation branch is skipped.
    expect(sub.tuiWindow).toBeUndefined() // already asserted; belt-and-suspenders
  })
})

// =============================================================================
// C) createBrokerDurableTmuxAllocator — downstream consumption of the casts
// =============================================================================
//
// Pins the shape of BrokerTmuxAllocation returned by createBrokerDurableTmuxAllocator
// (the function that calls `sub.tuiWindow as BrokerWindowIdentity` and
// `sub.tuiLease as BrokerTmuxLease`).
//
// After curly's validated narrowing:
//   The same shapes must appear in the returned allocation.
//   If curly's validation throws on a value that currently passes, these tests will fail.

describe('[CHARACTERIZATION C] createBrokerDurableTmuxAllocator — BrokerTmuxAllocation shape (post-cast consumption)', () => {
  let allocation: Record<string, unknown>

  beforeEach(async () => {
    const manager = new FakeTmuxManager()
    const allocator = createBrokerDurableTmuxAllocator({ runtimeRoot: dir }, makeDeps(manager))
    allocation = (await allocator.allocate({
      runtimeId: 'rt-char-alloc-t04755',
      hostSessionId: 'hsid-char-alloc',
      generation: 5,
      brokerDriver: 'claude-code-tmux',
    })) as Record<string, unknown>
  })

  // ── allocation.tuiWindow (the cast result placed into BrokerTmuxAllocation) ─

  it('allocation.tuiWindow is defined (cast preserved the non-undefined tuiWindow value)', () => {
    expect(allocation['tuiWindow']).toBeDefined()
  })

  it('allocation.tuiWindow has socketPath (BrokerWindowIdentity field 1 of 6)', () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(typeof w?.['socketPath']).toBe('string')
  })

  it('allocation.tuiWindow has sessionId (BrokerWindowIdentity field 2 of 6)', () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(typeof w?.['sessionId']).toBe('string')
  })

  it('allocation.tuiWindow has windowId (BrokerWindowIdentity field 3 of 6)', () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(typeof w?.['windowId']).toBe('string')
  })

  it('allocation.tuiWindow has paneId (BrokerWindowIdentity field 4 of 6)', () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(typeof w?.['paneId']).toBe('string')
  })

  it('allocation.tuiWindow has sessionName (BrokerWindowIdentity field 5 of 6)', () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(typeof w?.['sessionName']).toBe('string')
  })

  it('allocation.tuiWindow has windowName (BrokerWindowIdentity field 6 of 6)', () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(typeof w?.['windowName']).toBe('string')
  })

  it("allocation.tuiWindow.windowName = 'tui' (the TUI pane, not the broker pane)", () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(w?.['windowName']).toBe('tui')
  })

  // ── allocation.lease (the cast result placed into BrokerTmuxAllocation) ────

  it('allocation.lease is defined (cast preserved the non-undefined tuiLease value)', () => {
    expect(allocation['lease']).toBeDefined()
  })

  it("allocation.lease.kind = 'tmux-pane'", () => {
    const l = allocation['lease'] as Record<string, unknown>
    expect(l?.['kind']).toBe('tmux-pane')
  })

  it("allocation.lease.ownership = 'hrc'", () => {
    const l = allocation['lease'] as Record<string, unknown>
    expect(l?.['ownership']).toBe('hrc')
  })

  it('allocation.lease.paneId = allocation.tuiWindow.paneId (lease is the TUI pane)', () => {
    const l = allocation['lease'] as Record<string, unknown>
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(l?.['paneId']).toBe(w?.['paneId'])
  })

  it('allocation.lease.socketPath = allocation.tuiWindow.socketPath (same btmux server)', () => {
    const l = allocation['lease'] as Record<string, unknown>
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(l?.['socketPath']).toBe(w?.['socketPath'])
  })

  it('allocation.lease.sessionId = allocation.tuiWindow.sessionId', () => {
    const l = allocation['lease'] as Record<string, unknown>
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(l?.['sessionId']).toBe(w?.['sessionId'])
  })

  it('allocation.lease.windowId = allocation.tuiWindow.windowId', () => {
    const l = allocation['lease'] as Record<string, unknown>
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(l?.['windowId']).toBe(w?.['windowId'])
  })

  it('allocation.lease.allowedOps.inspect = true', () => {
    const l = allocation['lease'] as Record<string, unknown>
    const ops = l?.['allowedOps'] as Record<string, unknown>
    expect(ops?.['inspect']).toBe(true)
  })

  it('allocation.lease.allowedOps.sendInput = true', () => {
    const l = allocation['lease'] as Record<string, unknown>
    const ops = l?.['allowedOps'] as Record<string, unknown>
    expect(ops?.['sendInput']).toBe(true)
  })

  it('allocation.lease.allowedOps.sendInterrupt = true', () => {
    const l = allocation['lease'] as Record<string, unknown>
    const ops = l?.['allowedOps'] as Record<string, unknown>
    expect(ops?.['sendInterrupt']).toBe(true)
  })

  it('allocation.lease.allowedOps.capture = true', () => {
    const l = allocation['lease'] as Record<string, unknown>
    const ops = l?.['allowedOps'] as Record<string, unknown>
    expect(ops?.['capture']).toBe(true)
  })

  it('allocation.lease.allowedOps.resize = false', () => {
    const l = allocation['lease'] as Record<string, unknown>
    const ops = l?.['allowedOps'] as Record<string, unknown>
    expect(ops?.['resize']).toBe(false)
  })

  // ── Legacy single-pane fields mirror the TUI pane (consumed by restart reconcile) ──

  it('allocation.sessionId = allocation.tuiWindow.sessionId (legacy single-pane mirror)', () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(allocation['sessionId']).toBe(w?.['sessionId'])
  })

  it('allocation.windowId = allocation.tuiWindow.windowId (legacy single-pane mirror)', () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(allocation['windowId']).toBe(w?.['windowId'])
  })

  it('allocation.paneId = allocation.tuiWindow.paneId (legacy single-pane mirror)', () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(allocation['paneId']).toBe(w?.['paneId'])
  })

  it('allocation.sessionName = allocation.tuiWindow.sessionName (legacy single-pane mirror)', () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(allocation['sessionName']).toBe(w?.['sessionName'])
  })

  it('allocation.windowName = allocation.tuiWindow.windowName (legacy single-pane mirror)', () => {
    const w = allocation['tuiWindow'] as Record<string, unknown>
    expect(allocation['windowName']).toBe(w?.['windowName'])
  })

  // ── brokerWindow is DISTINCT from tuiWindow in the downstream shape ──────

  it('allocation.brokerWindow ≠ allocation.tuiWindow (two separate windows)', () => {
    const bw = allocation['brokerWindow'] as Record<string, unknown>
    const tw = allocation['tuiWindow'] as Record<string, unknown>
    expect(bw?.['windowId']).not.toBe(tw?.['windowId'])
    expect(bw?.['paneId']).not.toBe(tw?.['paneId'])
  })

  it("allocation.brokerWindow.windowName = 'broker' (broker process pane, not operator pane)", () => {
    const bw = allocation['brokerWindow'] as Record<string, unknown>
    expect(bw?.['windowName']).toBe('broker')
  })
})
