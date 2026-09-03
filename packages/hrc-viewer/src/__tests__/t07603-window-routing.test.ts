/**
 * T-07603 — route viewer tabs by scope shape, adopt the interactive window.
 *
 * Under T-07118 the window came from an operator-applied `hrc_window_key` stamp,
 * and an absent hint always meant the headless window. Both change here:
 *
 *  - placement is derived from the scope's SHAPE (`T-XXXXX` is background work,
 *    everything the operator named is foreground),
 *  - the interactive window is ADOPTED from what is already open rather than
 *    stamped by hand, so it survives Ghostty restarts wiping window metadata.
 *
 * The reap-safety case is the one that earns its keep: HRC now creates and kills
 * panes inside a window the operator personally uses.
 */

import { describe, expect, it } from 'bun:test'

import {
  CHIEF_WINDOW_KEY,
  DEFAULT_HEADLESS_WINDOW_KEY,
  GhostmuxManager,
  INTERACTIVE_WINDOW_KEY,
  defaultWindowKeyForTab,
  deriveHeadlessTabIdentity,
  headlessWindowTitle,
  resolveWindowKey,
} from '../ghostmux'

const windowKeyFor = (scopeRef: string, hint?: string | undefined) =>
  resolveWindowKey(hint, deriveHeadlessTabIdentity(scopeRef))

describe('T-07603 scope-shape routing', () => {
  it('sends hcs-project task scopes to the chief window', () => {
    expect(windowKeyFor('agent:cody:project:hcs:task:T-12345')).toBe(CHIEF_WINDOW_KEY)
    expect(windowKeyFor('agent:chief:project:hcs:task:T-12345')).toBe(CHIEF_WINDOW_KEY)
  })

  it('still sends task scopes in other projects to the headless window', () => {
    expect(windowKeyFor('agent:cody:project:hrc-runtime:task:T-12345')).toBe(
      DEFAULT_HEADLESS_WINDOW_KEY
    )
    expect(windowKeyFor('agent:cody:project:hrc-runtime:task:T-07595')).toBe(
      DEFAULT_HEADLESS_WINDOW_KEY
    )
    // Role-qualified seats inherit the task id, so they stay background too.
    expect(windowKeyFor('agent:clod:project:hrc-runtime:task:T-07595:role:p3-prod-run')).toBe(
      DEFAULT_HEADLESS_WINDOW_KEY
    )
  })

  it('sends every chief scope to the dedicated chief window', () => {
    expect(windowKeyFor('agent:chief:project:hcs:task:primary')).toBe(CHIEF_WINDOW_KEY)
  })

  it('sends operator-named scopes to the interactive window', () => {
    expect(windowKeyFor('agent:mable:project:hcs:task:primary')).toBe(INTERACTIVE_WINDOW_KEY)
    for (const scopeRef of [
      'agent:clod:project:hrc-runtime:task:primary',
      'agent:mable:project:hrc-runtime:task:primary-nova',
      'agent:clod:project:hrc-runtime:task:minisvc',
      'agent:clod:project:hrc-runtime:task:minilab',
      'agent:clod:project:hrc-runtime:task:viewrca',
    ]) {
      expect(windowKeyFor(scopeRef)).toBe(INTERACTIVE_WINDOW_KEY)
    }
  })

  it('sends an UNPARSEABLE scope to the headless window, never the operator’s', () => {
    // `deriveHeadlessTabIdentity` returns before `isRealTaskId` for a scope it
    // cannot parse, so keying off a bare taskId would land junk in the operator's
    // window. Malformed input belongs in the background pile.
    const tab = deriveHeadlessTabIdentity('this is not a scope ref')
    expect(tab.tabKey.startsWith('unparsed:')).toBe(true)
    expect(defaultWindowKeyForTab(tab)).toBe(DEFAULT_HEADLESS_WINDOW_KEY)
  })

  it('an explicit hint always wins over the derived key', () => {
    expect(windowKeyFor('agent:cody:project:hcs:task:T-12345', 'console')).toBe(
      INTERACTIVE_WINDOW_KEY
    )
    // A task scope forced into the interactive window...
    expect(windowKeyFor('agent:cody:project:hrc-runtime:task:T-07595', 'console')).toBe('console')
    // ...and an operator scope forced into the headless pile.
    expect(windowKeyFor('agent:clod:project:hrc-runtime:task:primary', 'default')).toBe('default')
    // Blank/whitespace hints are absent hints, not keys.
    expect(windowKeyFor('agent:clod:project:hrc-runtime:task:primary', '   ')).toBe(
      INTERACTIVE_WINDOW_KEY
    )
  })

  it('gives the dedicated chief window its own presentation title', () => {
    expect(headlessWindowTitle(CHIEF_WINDOW_KEY)).toBe('Chief Contexts')
    expect(headlessWindowTitle(DEFAULT_HEADLESS_WINDOW_KEY)).toBe('Headless Sessions')
    expect(headlessWindowTitle(INTERACTIVE_WINDOW_KEY)).toBe('Headless Sessions · console')
  })
})

type Win = { metadata: Record<string, unknown>; seq: number }
type Surf = { windowId: string; meta: Record<string, unknown>; title?: string | undefined }

/** Minimal windows-API fake: enough to exercise adoption and reap fencing. */
function makeFake() {
  const windows = new Map<string, Win>()
  const surfaces = new Map<string, Surf>()
  const calls: string[][] = []
  let seq = 0
  const argAfter = (args: string[], flag: string) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  const allocWindow = (metadata: Record<string, unknown> = {}) => {
    seq += 1
    const id = `win-${seq}`
    windows.set(id, { metadata, seq })
    return id
  }
  const allocSurface = (windowId: string, meta: Record<string, unknown> = {}) => {
    seq += 1
    const id = `surf-${seq}`
    surfaces.set(id, { windowId, meta })
    return id
  }
  const runner = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'list-windows') {
      const filters = args
        .map((arg, index) => (arg === '--meta' ? args[index + 1] : undefined))
        .filter((pair): pair is string => pair !== undefined)
        .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
      const matching = [...windows.entries()]
        .sort((a, b) => a[1].seq - b[1].seq)
        .filter(([, w]) => filters.every(([k, v]) => w.metadata[k ?? ''] === v))
      return {
        stdout: JSON.stringify({
          windows: matching.map(([id, w]) => ({ id, metadata: w.metadata, terminal_ids: [] })),
        }),
        stderr: '',
      }
    }
    if (args[0] === 'metadata') {
      const windowId = argAfter(args, '--window-id')
      const json = args.slice(2).find((a) => a.trim().startsWith('{')) ?? '{}'
      if (windowId !== undefined) {
        const window = windows.get(windowId)
        if (window) window.metadata = { ...window.metadata, ...JSON.parse(json) }
        return { stdout: '{}', stderr: '' }
      }
      const surface = surfaces.get(argAfter(args, '-t') ?? '')
      if (args[1] === 'set') {
        if (surface) surface.meta = { ...surface.meta, ...JSON.parse(json) }
        return { stdout: '{}', stderr: '' }
      }
      return { stdout: JSON.stringify({ data: surface?.meta ?? {} }), stderr: '' }
    }
    if (args[0] === 'new' && args.includes('--window')) {
      const findBy = JSON.parse(argAfter(args, '--find-or-create-by') ?? '{}')
      const meta = JSON.parse(argAfter(args, '--metadata') ?? '{}')
      const hit = [...windows.entries()]
        .sort((a, b) => a[1].seq - b[1].seq)
        .find(([, w]) => Object.entries(findBy).every(([k, v]) => w.metadata[k] === v))
      if (hit) return { stdout: JSON.stringify({ id: hit[0], created: false }), stderr: '' }
      const id = allocWindow({ ...meta, ...findBy })
      return { stdout: JSON.stringify({ id, created: true }), stderr: '' }
    }
    if (args[0] === 'new') {
      const id = allocSurface(argAfter(args, '--window-id') ?? 'win-0')
      return { stdout: JSON.stringify({ id, window_id: surfaces.get(id)?.windowId }), stderr: '' }
    }
    if (args[0] === 'new-pane') {
      // Split: the new pane lands in the same window as its split target.
      const target = surfaces.get(argAfter(args, '-t') ?? '')
      const id = allocSurface(target?.windowId ?? 'win-0')
      return { stdout: JSON.stringify({ id, window_id: surfaces.get(id)?.windowId }), stderr: '' }
    }
    if (args[0] === 'list-surfaces') {
      return {
        stdout: JSON.stringify({
          terminals: [...surfaces.entries()].map(([id, s]) => ({
            id,
            window_id: s.windowId,
            columns: 120,
            rows: 40,
          })),
        }),
        stderr: '',
      }
    }
    if (args[0] === 'kill-surface') {
      surfaces.delete(argAfter(args, '-t') ?? '')
      return { stdout: '{}', stderr: '' }
    }
    return { stdout: '{}', stderr: '' }
  }
  return { runner, calls, windows, surfaces, allocWindow, allocSurface }
}

const PRIMARY = 'agent:clod:project:hrc-runtime:task:primary'

describe('T-07603 interactive-window adoption', () => {
  it('adopts the OLDEST untagged window and stamps it', async () => {
    const fake = makeFake()
    const oldest = fake.allocWindow()
    fake.allocWindow()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: PRIMARY, runtimeId: 'rt-1', attachCommand: 'a' })

    expect(fake.windows.get(oldest)?.metadata).toMatchObject({
      hrc_role: 'headless-sessions-window',
      hrc_window_key: INTERACTIVE_WINDOW_KEY,
    })
    // Adopted, not created: still exactly the two windows we started with.
    expect(fake.windows.size).toBe(2)
  })

  it('never adopts a window already tagged for the headless pile', async () => {
    const fake = makeFake()
    const headless = fake.allocWindow({
      hrc_role: 'headless-sessions-window',
      hrc_window_key: DEFAULT_HEADLESS_WINDOW_KEY,
    })
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: PRIMARY, runtimeId: 'rt-1', attachCommand: 'a' })

    expect(fake.windows.get(headless)?.metadata['hrc_window_key']).toBe(DEFAULT_HEADLESS_WINDOW_KEY)
    // No untagged candidate ⇒ a fresh interactive window was created instead.
    expect(fake.windows.size).toBe(2)
  })

  it('creates an interactive window when nothing is open at all', async () => {
    const fake = makeFake()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: PRIMARY, runtimeId: 'rt-1', attachCommand: 'a' })

    expect(fake.windows.size).toBe(1)
    expect([...fake.windows.values()][0]?.metadata['hrc_window_key']).toBe(INTERACTIVE_WINDOW_KEY)
  })

  it('reuses the adopted window on later placements without re-scanning', async () => {
    const fake = makeFake()
    fake.allocWindow()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: PRIMARY, runtimeId: 'rt-1', attachCommand: 'a' })
    const scansAfterFirst = fake.calls.filter(
      (c) => c[0] === 'list-windows' && !c.includes('--meta')
    ).length

    await manager.ensureHeadlessViewer({
      scopeRef: 'agent:mable:project:hrc-runtime:task:primary',
      runtimeId: 'rt-2',
      attachCommand: 'b',
    })

    // Steady state is the `--meta` filtered read alone; no further full scan.
    expect(fake.calls.filter((c) => c[0] === 'list-windows' && !c.includes('--meta')).length).toBe(
      scansAfterFirst
    )
    expect(fake.windows.size).toBe(1)
  })
})

describe('T-07930 non-interactive keyed-window isolation', () => {
  it('creates a dedicated chief window without stamping the operator window', async () => {
    const fake = makeFake()
    const operatorWindow = fake.allocWindow()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    const result = await manager.ensureHeadlessViewer({
      scopeRef: 'agent:chief:project:hcs:task:T-07930',
      runtimeId: 'rt-chief',
      attachCommand: 'a',
    })

    expect(result.status).toBe('created')
    if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`)
    expect(fake.windows.get(operatorWindow)?.metadata).toEqual({})
    expect(fake.windows.size).toBe(2)

    const chiefWindow = [...fake.windows.entries()].find(
      ([, window]) => window.metadata['hrc_window_key'] === CHIEF_WINDOW_KEY
    )
    expect(chiefWindow?.[1].metadata).toMatchObject({
      hrc_role: 'headless-sessions-window',
      hrc_window_key: CHIEF_WINDOW_KEY,
    })
    expect(fake.surfaces.get(result.surfaceId)?.windowId).toBe(chiefWindow?.[0])
  })

  it('creates a custom keyed window without adopting the operator window', async () => {
    const fake = makeFake()
    const operatorWindow = fake.allocWindow()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    const result = await manager.ensureHeadlessViewer({
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-07930',
      runtimeId: 'rt-custom',
      attachCommand: 'a',
      windowKey: 'review',
    })

    expect(result.status).toBe('created')
    if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`)
    expect(fake.windows.get(operatorWindow)?.metadata).toEqual({})
    expect(fake.windows.size).toBe(2)

    const customWindow = [...fake.windows.entries()].find(
      ([, window]) => window.metadata['hrc_window_key'] === 'review'
    )
    expect(fake.surfaces.get(result.surfaceId)?.windowId).toBe(customWindow?.[0])
  })
})

describe('T-07603 reap safety inside an adopted operator window', () => {
  it('refuses to reap a surface the operator owns', async () => {
    const fake = makeFake()
    const operatorWindow = fake.allocWindow()
    // A tab Lance opened himself: no HRC metadata of any kind.
    const operatorTab = fake.allocSurface(operatorWindow, {})
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({ scopeRef: PRIMARY, runtimeId: 'rt-1', attachCommand: 'a' })
    expect(fake.windows.get(operatorWindow)?.metadata['hrc_window_key']).toBe(
      INTERACTIVE_WINDOW_KEY
    )

    // The reap path is metadata-fenced: an operator tab is not an agent pane, so
    // it survives even though HRC now owns the window it lives in.
    expect(await manager.reapHeadlessAgentPane(operatorTab, 'rt-1')).toMatchObject({
      status: 'skipped',
      reason: 'not_agent_pane',
    })
    expect(fake.surfaces.has(operatorTab)).toBe(true)
  })
})
