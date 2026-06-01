/**
 * RED tests (T-01812 / T-01801 Phase 3) — NAMED-WINDOW tmux operations.
 *
 * Governing task: T-01812 (parent T-01801, refinement C-03099). Phase 3 puts the
 * broker process and the operator TUI into TWO named windows ('broker' and 'tui')
 * under ONE per-runtime btmux socket/session. The broker window is launched
 * EXEC-FORM (`new-window -d 'exec harness-broker … --transport unix'`) so the
 * broker is the pane root process, NOT a shell receiving pasted keys.
 *
 * At HEAD, `TmuxManager` (packages/hrc-server/src/tmux.ts) is single-window:
 *   - `WINDOW_NAME = 'main'` is HARDCODED (:50)
 *   - `inspectSession()` queries `=${sessionName}:main` (:316)
 *   - `createNamedSession()` makes exactly one window named 'main' (:380-399)
 * There is NO way to (a) create a second NAMED window, (b) launch a window with
 * an exec-form command, (c) inspect a window BY NAME, or (d) inspect the running
 * process of a specific pane. These tests pin those new operations and are
 * EXPECTED TO FAIL NOW (the methods are `undefined` → TypeError on call).
 *
 * Expected NEW symbols on TmuxManager (proposed contract — implementer matches):
 *   - createWindowWithCommand({ sessionName, windowName, command }): Promise<TmuxPaneState>
 *       Creates the session if absent, then a window named `windowName` whose pane
 *       root runs `command` via tmux exec-form (new-window -d -n <window> '<cmd>').
 *   - createOrInspectWindow({ sessionName, windowName }): Promise<TmuxPaneState>
 *       Idempotent named-window create/inspect (bare shell window for the TUI).
 *   - inspectWindow({ sessionName, windowName }): Promise<TmuxPaneState | null>
 *       Named-window inspect — replaces the hardcoded `:main` assumption.
 *   - inspectPaneProcess(paneId): Promise<{ command: string; pid: number; dead: boolean } | null>
 *       Running-process identity for a specific pane (pane_current_command + pane_pid).
 *
 * These use a REAL tmux binary on a TEMP socket (tmux behavior is under test).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTmuxManager } from '../index'
import type { TmuxManager } from '../index'

// Anything in this set carries the named-window contract under test.
type NamedWindowOps = TmuxManager & {
  createWindowWithCommand(input: {
    sessionName: string
    windowName: string
    command: string
  }): Promise<{ sessionId: string; windowId: string; paneId: string; windowName: string }>
  createOrInspectWindow(input: {
    sessionName: string
    windowName: string
  }): Promise<{ sessionId: string; windowId: string; paneId: string; windowName: string }>
  inspectWindow(input: {
    sessionName: string
    windowName: string
  }): Promise<{ sessionId: string; windowId: string; paneId: string; windowName: string } | null>
  inspectPaneProcess(
    paneId: string
  ): Promise<{ command: string; pid: number; dead: boolean } | null>
}

let dir: string
const sockets: string[] = []

async function killSocket(socketPath: string): Promise<void> {
  try {
    const { exited } = Bun.spawn(['tmux', '-S', socketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited
  } catch {
    // fine when no server exists
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-btmux-windows-'))
})

afterEach(async () => {
  for (const socketPath of sockets.splice(0)) {
    await killSocket(socketPath)
  }
  await rm(dir, { recursive: true, force: true })
})

function newManager(): { manager: NamedWindowOps; socketPath: string } {
  const socketPath = join(dir, `btmux-${sockets.length}.sock`)
  sockets.push(socketPath)
  const manager = createTmuxManager({ socketPath }) as NamedWindowOps
  return { manager, socketPath }
}

describe('T-01812 Phase 3 — broker + TUI as two named windows under one socket', () => {
  it('creates TWO distinct named windows (broker + tui) under ONE session on ONE socket (RED)', async () => {
    const { manager } = newManager()
    await manager.initialize()

    const sessionName = 'hrc-claude-code-tmux-runtime_p3'

    // Broker window: exec-form command launched as the pane root. We use a long
    // `sleep` as a stand-in for `exec harness-broker … --transport unix` so the
    // pane has a deterministic, non-shell foreground process to inspect.
    const broker = await manager.createWindowWithCommand({
      sessionName,
      windowName: 'broker',
      command: 'exec sleep 312',
    })

    // TUI window: a bare lease window (the harness/driver attaches to its pane).
    const tui = await manager.createOrInspectWindow({ sessionName, windowName: 'tui' })

    expect(broker.windowName).toBe('broker')
    expect(tui.windowName).toBe('tui')

    // ONE session: same session id; DISTINCT windows + panes.
    expect(broker.sessionId).toBe(tui.sessionId)
    expect(broker.windowId).not.toBe(tui.windowId)
    expect(broker.paneId).not.toBe(tui.paneId)
  })

  it('inspects each window BY NAME — not the hardcoded "main" window (RED)', async () => {
    const { manager } = newManager()
    await manager.initialize()
    const sessionName = 'hrc-claude-code-tmux-runtime_byname'

    const broker = await manager.createWindowWithCommand({
      sessionName,
      windowName: 'broker',
      command: 'exec sleep 313',
    })
    const tui = await manager.createOrInspectWindow({ sessionName, windowName: 'tui' })

    const inspectedBroker = await manager.inspectWindow({ sessionName, windowName: 'broker' })
    const inspectedTui = await manager.inspectWindow({ sessionName, windowName: 'tui' })

    expect(inspectedBroker?.paneId).toBe(broker.paneId)
    expect(inspectedTui?.paneId).toBe(tui.paneId)
    // The two named windows must resolve to different panes — proof the manager
    // is no longer locked to a single 'main' window.
    expect(inspectedBroker?.paneId).not.toBe(inspectedTui?.paneId)
  })

  it('launches the broker window EXEC-FORM so the pane root is the command, not a shell (RED)', async () => {
    const { manager } = newManager()
    await manager.initialize()
    const sessionName = 'hrc-claude-code-tmux-runtime_exec'

    const broker = await manager.createWindowWithCommand({
      sessionName,
      windowName: 'broker',
      command: 'exec sleep 314',
    })

    const proc = await manager.inspectPaneProcess(broker.paneId)
    expect(proc).not.toBeNull()
    expect(proc?.dead).toBe(false)
    // EXEC-FORM proof: the pane's foreground command is the launched binary
    // ('sleep'), NOT an interactive shell waiting for pasted keys.
    expect(proc?.command).toBe('sleep')
    expect(['sh', 'bash', 'zsh', 'fish', '-zsh', '-bash']).not.toContain(proc?.command)
    expect(typeof proc?.pid).toBe('number')
    expect(proc?.pid).toBeGreaterThan(0)
  })

  it('createOrInspectWindow is idempotent for the TUI window (RED)', async () => {
    const { manager } = newManager()
    await manager.initialize()
    const sessionName = 'hrc-claude-code-tmux-runtime_idem'

    const first = await manager.createOrInspectWindow({ sessionName, windowName: 'tui' })
    const second = await manager.createOrInspectWindow({ sessionName, windowName: 'tui' })

    expect(second.windowId).toBe(first.windowId)
    expect(second.paneId).toBe(first.paneId)
  })
})
