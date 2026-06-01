/**
 * RED test (T-01814 / T-01801 Phase 5) — `hrc server tmux status` must show
 * BOTH the `broker` and `tui` panes for a per-runtime btmux lease, along with
 * the lease's controlMode / brokerAttached state.
 *
 * Today `formatTmuxStatus` renders a lease as a single line:
 *     - <socket>: <session list>
 * which only proves a lease server exists — it does NOT distinguish the broker
 * control pane from the operator TUI pane, and shows no control mode. After
 * Phase 3 each per-runtime btmux session owns TWO named windows (`broker` +
 * `tui`); the operator status surface must reflect both so a human can tell
 * which pane is the broker child vs. which pane to attach to, and whether the
 * runtime is broker-attached or degraded.
 *
 * Exercises the REAL formatter (pure function) — NO live tmux/broker. The
 * extended lease shape is constructed directly.
 *
 * ── Expected NEW TmuxLeaseStatus shape (implementer matches) ──
 *   TmuxLeaseStatus = {
 *     socketPath: string
 *     running: boolean
 *     sessions: string[]
 *     controlMode?: string             // e.g. 'broker-ipc' | 'direct-tmux-degraded'
 *     brokerAttached?: boolean
 *     brokerPane?: { windowName: string; paneId: string; pid?: number | undefined }
 *     tuiPane?: { windowName: string; paneId: string }
 *   }
 *
 * ── Expected formatTmuxStatus per-lease rendering (implementer matches) ──
 *     - <socket>: <session list>
 *         control: <controlMode> (attached=yes|no)
 *         broker:  window=broker pane=<paneId> pid=<pid>
 *         tui:     window=tui pane=<paneId>
 *
 * At HEAD the formatter ignores the new fields, so the assertions below FAIL
 * until Phase 5 extends TmuxLeaseStatus + formatTmuxStatus.
 */
import { describe, expect, it } from 'bun:test'

import { formatTmuxStatus } from '../cli-runtime'
import type { TmuxStatus } from '../cli-runtime'

const BTMUX_SOCKET = '/tmp/hrc/btmux/claude-code-rt_panes.sock'
const SESSION_NAME = 'hrc-claude-code-rt_panes'

// Extended lease shape Phase 5 introduces. Cast through `unknown` so the test
// compiles against the HEAD type while still asserting the target behavior.
function statusWithBrokerAndTuiPanes(): TmuxStatus {
  return {
    available: true,
    version: 'tmux 3.4',
    socketPath: '/tmp/hrc/hrc-tmux.sock',
    running: true,
    sessionCount: 0,
    sessions: [],
    leases: [
      {
        socketPath: BTMUX_SOCKET,
        running: true,
        sessions: [SESSION_NAME],
        controlMode: 'broker-ipc',
        brokerAttached: true,
        brokerPane: { windowName: 'broker', paneId: '%7', pid: 54321 },
        tuiPane: { windowName: 'tui', paneId: '%8' },
      },
    ],
  } as unknown as TmuxStatus
}

describe('RED: tmux status shows broker + tui panes per btmux lease (T-01814)', () => {
  it('renders BOTH the broker pane and the tui pane for a lease', () => {
    const out = formatTmuxStatus(statusWithBrokerAndTuiPanes())

    // Broker control pane.
    expect(out).toContain('broker')
    expect(out).toContain('%7')
    // Operator TUI pane.
    expect(out).toContain('tui')
    expect(out).toContain('%8')
    // Both panes must be present together — a single-line lease can't satisfy this.
    const brokerIdx = out.indexOf('%7')
    const tuiIdx = out.indexOf('%8')
    expect(brokerIdx).toBeGreaterThanOrEqual(0)
    expect(tuiIdx).toBeGreaterThanOrEqual(0)
    expect(brokerIdx).not.toBe(tuiIdx)
  })

  it('surfaces controlMode and brokerAttached for the lease', () => {
    const out = formatTmuxStatus(statusWithBrokerAndTuiPanes())
    expect(out).toContain('broker-ipc')
    // brokerAttached=true should render a clear attached indicator.
    expect(out.toLowerCase()).toContain('attached')
  })

  it('renders a degraded lease with its degraded controlMode and no broker attachment', () => {
    const degraded = {
      available: true,
      version: 'tmux 3.4',
      socketPath: '/tmp/hrc/hrc-tmux.sock',
      running: true,
      sessionCount: 0,
      sessions: [],
      leases: [
        {
          socketPath: BTMUX_SOCKET,
          running: true,
          sessions: [SESSION_NAME],
          controlMode: 'direct-tmux-degraded',
          brokerAttached: false,
          // Broker pane is gone in the degraded case; only the TUI pane remains.
          tuiPane: { windowName: 'tui', paneId: '%8' },
        },
      ],
    } as unknown as TmuxStatus

    const out = formatTmuxStatus(degraded)
    expect(out).toContain('direct-tmux-degraded')
    expect(out).toContain('tui')
    expect(out).toContain('%8')
  })
})
