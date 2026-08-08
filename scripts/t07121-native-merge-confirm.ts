#!/usr/bin/env bun
/**
 * T-07121 — OPTIONAL operator confirmation of the residency fence under a REAL
 * macOS native tab-drag merge.
 *
 * The automated live smoke synthesized both post-merge states (a dissolved
 * registry entry whose panes survive wearing the stale key, and a live entry with
 * a stale-keyed pane resident elsewhere) because Ghostty's only merge affordance
 * is Window ▸ Merge All Windows, which is GLOBAL — running it unattended would
 * swallow the live agent window. This script does the same check with a human
 * doing the drag, so nothing else on the desktop is touched.
 *
 * Total hands-on time: about two minutes.
 *
 *   bun scripts/t07121-native-merge-confirm.ts
 *
 * Phase 1 creates two throwaway keyed windows and stops.
 * You drag one window's tab onto the other window's tab bar (native merge).
 * Press Enter; phase 2 asserts the fence and reaps everything it created.
 *
 * It only ever touches windows it created itself — every id is captured up front
 * and re-checked before any kill.
 */
import { createInterface } from 'node:readline/promises'

import { GhostmuxManager } from '../packages/hrc-server/src/ghostmux'

const KEY_LEFT = 't07121-drag-left'
const KEY_RIGHT = 't07121-drag-right'
const ATTACH = "printf 'T-07121 merge-confirm pane — safe to close\\n'; sleep 1800"
/** One tabKey for every pane, so residency is the ONLY thing deciding placement. */
const scopeFor = (agent: string) => `agent:${agent}:project:hrc-runtime:task:T-07121`

type WindowRow = { id: string; title: string; metadata: Record<string, unknown> }
type TermRow = { id: string; title?: string; window_id?: string }

const ghostmux = async (args: string[]): Promise<string> => {
  const proc = Bun.spawn(['ghostmux', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(err.trim() || out.trim() || `ghostmux ${args[0]} failed`)
  return out
}
const listWindows = async (): Promise<WindowRow[]> =>
  (JSON.parse(await ghostmux(['list-windows', '--json'])) as { windows: WindowRow[] }).windows
const listSurfaces = async (): Promise<TermRow[]> =>
  (JSON.parse(await ghostmux(['list-surfaces', '--json'])) as { terminals: TermRow[] }).terminals
const windowFor = async (key: string): Promise<WindowRow | undefined> =>
  (await listWindows()).find((w) => w.metadata['hrc_window_key'] === key)
const residencyOf = async (surfaceId: string): Promise<string | undefined> =>
  (await listSurfaces()).find((t) => t.id === surfaceId)?.window_id
const surfaceIdOf = (result: { surfaceId?: string }): string => {
  if (!result.surfaceId) throw new Error('viewer creation returned no surface')
  return result.surfaceId
}

const manager = new GhostmuxManager('ghostmux', undefined, 15_000)
const created = new Set<string>()

const place = async (agent: string, key: string): Promise<string> => {
  const result = await manager.ensureHeadlessViewer({
    scopeRef: scopeFor(agent),
    runtimeId: `rt-${agent}`,
    attachCommand: ATTACH,
    windowKey: key,
  })
  if (result.status === 'failed') throw new Error(`viewer placement failed: ${result.error}`)
  const surfaceId = surfaceIdOf(result)
  created.add(surfaceId)
  return surfaceId
}

// ── Phase 1: two keyed windows, one pane each, same tabKey ────────────────────
await place('dragleft', KEY_LEFT)
const paneRight = await place('dragright', KEY_RIGHT)
const winLeft = await windowFor(KEY_LEFT)
const winRight = await windowFor(KEY_RIGHT)
if (!winLeft || !winRight || winLeft.id === winRight.id) {
  throw new Error('setup failed: expected two distinct keyed windows')
}
// Remember the initial members so cleanup never reaps a pane we did not create.
for (const surface of await listSurfaces()) {
  if (surface.window_id === winLeft.id || surface.window_id === winRight.id) {
    created.add(surface.id)
  }
}

console.log(`
Two throwaway windows are open:

  "Headless Sessions · ${KEY_LEFT}"   (window ${winLeft.id})
  "Headless Sessions · ${KEY_RIGHT}"  (window ${winRight.id})

Now do the native merge BY HAND:

  drag any tab out of the "${KEY_RIGHT}" window and drop it onto the
  tab bar of the "${KEY_LEFT}" window, until the "${KEY_RIGHT}" window is
  empty and gone.

(Window ▸ Merge All Windows also works but is GLOBAL — it would swallow your
live agent window too. Use the drag.)
`)

const rl = createInterface({ input: process.stdin, output: process.stdout })
await rl.question('Press Enter when the merge is done… ')
rl.close()

// ── Phase 2: assert the fence against the real post-merge state ───────────────
const rightAfter = await windowFor(KEY_RIGHT)
const rightPaneHome = await residencyOf(paneRight)
const rightPaneMeta = JSON.parse(
  await ghostmux(['metadata', 'get', '-t', paneRight, '--json'])
) as {
  data: Record<string, unknown>
}
console.log(`
observed after your drag:
  "${KEY_RIGHT}" registry entry : ${rightAfter ? `alive (${rightAfter.id})` : 'RETIRED'}
  its pane now resides in       : ${rightPaneHome}
  its pane still wears the key  : ${String(rightPaneMeta.data['hrc_window_key'])}
`)

/** Reap only what this script created, then leave. */
const cleanup = async (): Promise<void> => {
  for (const surfaceId of created) {
    await ghostmux(['kill-surface', '-t', surfaceId, '--force']).catch(() => undefined)
  }
  console.log(`reaped ${created.size} throwaway surfaces; nothing else was touched.`)
}

if (rightPaneHome === winRight.id && rightAfter) {
  console.log('❌ no merge detected — the panes never moved. Re-run and drag first.')
  await cleanup()
  process.exit(1)
}

// The decisive move: a hinted start for the merged-away key, same tabKey as the
// stale pane. It must land in a keyed window, never split into the stale pane.
const paneProbe = await place('dragprobe', KEY_RIGHT)
const winRightFresh = await windowFor(KEY_RIGHT)
const probeHome = await residencyOf(paneProbe)
const stalePaneHome = await residencyOf(paneRight)
for (const surface of await listSurfaces()) {
  if (surface.window_id === winRightFresh?.id) created.add(surface.id)
}

const landedInKeyedWindow = !!winRightFresh && probeHome === winRightFresh.id
const didNotSplitIntoStalePane = probeHome !== stalePaneHome
const pass = landedInKeyedWindow && didNotSplitIntoStalePane

console.log(`${pass ? '✅ PASS' : '❌ FAIL'} residency fence under a NATIVE tab-drag merge
  keyed window for "${KEY_RIGHT}" : ${winRightFresh?.id ?? '<none>'}
  new pane resides in             : ${probeHome}
  stale-keyed pane resides in     : ${stalePaneHome}
  landed in the keyed window      : ${landedInKeyedWindow}
  did NOT split into stale pane   : ${didNotSplitIntoStalePane}
`)

await cleanup()
process.exit(pass ? 0 : 1)
