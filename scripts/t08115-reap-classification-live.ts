#!/usr/bin/env bun
/**
 * T-08115 — live conformance probe for the reap skip classification.
 *
 * Runs `GhostmuxManager.reapHeadlessAgentPane` against surfaces that really
 * exist in the running Ghostty, via the real `ghostmux` binary. A fake agrees
 * with whatever its author believed; this does not.
 *
 * The half worth guarding is the REFUSAL. A reaper that removed everything
 * would pass a "the pane is reaped" test just as well as a correct one, so
 * every refusal case here asserts the surface is still alive afterwards.
 *
 *   bun scripts/t08115-reap-classification-live.ts
 *
 * Requires a running Ghostty with ghostmux on PATH. Creates its own throwaway
 * windows and removes them in a finally block.
 */
import { GhostmuxManager } from '../packages/hrc-viewer/src/ghostmux'

const ghostmux = async (args: string[]): Promise<string> => {
  const proc = Bun.spawn(['ghostmux', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(err.trim() || out.trim())
  return out
}

const exists = async (surfaceId: string): Promise<boolean> => {
  const parsed = JSON.parse(await ghostmux(['list-surfaces', '--json'])) as {
    terminals: { id: string }[]
  }
  return parsed.terminals.some((t) => t.id.toLowerCase() === surfaceId.toLowerCase())
}

const newSurface = async (title: string): Promise<string> => {
  // `new --window --json` answers the WINDOW id in `id`; the surface we want is
  // in `terminal_ids`, and list-surfaces never contains a window id.
  const parsed = JSON.parse(await ghostmux(['new', '--window', '--title', title, '--json'])) as {
    terminal_ids?: string[]
  }
  const id = parsed.terminal_ids?.[0]
  if (typeof id !== 'string') throw new Error(`no terminal id for ${title}`)
  // libghostty realizes the surface asynchronously.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await exists(id)) return id
    await Bun.sleep(100)
  }
  throw new Error(`surface ${id} never realized`)
}

const stamp = async (surfaceId: string, metadata: Record<string, unknown>): Promise<void> => {
  await ghostmux(['metadata', 'set', '-t', surfaceId, JSON.stringify(metadata), '--json'])
}

const failures: string[] = []
const check = (name: string, ok: boolean, detail: string): void => {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

const manager = new GhostmuxManager('ghostmux')
const created: string[] = []

try {
  // 1. A pane we own must be reaped — and must really leave the screen.
  const owned = await newSurface('t08115-owned')
  created.push(owned)
  await stamp(owned, {
    hrc_role: 'headless-agent-pane',
    hrc_runtime_id: 'rt-t08115-owned',
    hrc_tab_key: 'task:T-08115-live',
    hrc_window_key: 'default',
  })
  const reaped = await manager.reapHeadlessAgentPane(owned, 'rt-t08115-owned')
  const gone = !(await exists(owned))
  check(
    'an owned agent pane is reaped and really disappears',
    reaped.status === 'reaped' && gone,
    `${JSON.stringify(reaped)} surfaceGone=${gone}`
  )

  // 2. THE REFUSAL, case one: a live pane carrying no hrc metadata at all.
  const shell = await newSurface('t08115-operator-shell')
  created.push(shell)
  const bare = await manager.reapHeadlessAgentPane(shell, 'rt-t08115-owned')
  const bareSurvived = await exists(shell)
  check(
    'a live pane with no hrc metadata is REFUSED and survives',
    bare.status === 'skipped' &&
      bare.reason === 'not_agent_pane' &&
      bare.observedRole === null &&
      bare.requiredRole === 'headless-agent-pane' &&
      bareSurvived,
    `${JSON.stringify(bare)} surfaceSurvived=${bareSurvived}`
  )

  // 3. THE REFUSAL, case two: a live pane holding a RIVAL hrc role, so the
  //    refusal is keyed on the role read and not merely on absent metadata.
  const anchor = await newSurface('t08115-anchor')
  created.push(anchor)
  await stamp(anchor, { hrc_role: 'headless-window-anchor' })
  const anchorResult = await manager.reapHeadlessAgentPane(anchor, 'rt-t08115-owned')
  const anchorSurvived = await exists(anchor)
  check(
    'a live window anchor is REFUSED and survives, naming the role it saw',
    anchorResult.status === 'skipped' &&
      anchorResult.reason === 'not_agent_pane' &&
      anchorResult.observedRole === 'headless-window-anchor' &&
      anchorSurvived,
    `${JSON.stringify(anchorResult)} surfaceSurvived=${anchorSurvived}`
  )

  // 4. An already-closed surface. This is the production line the bug report
  //    was built from: it used to be reported as `not_agent_pane`.
  const missing = await manager.reapHeadlessAgentPane(
    '00000000-0000-0000-0000-000000000000',
    'rt-t08115-owned'
  )
  check(
    'an already-closed surface reports surface_missing, not not_agent_pane',
    missing.status === 'skipped' && missing.reason === 'surface_missing',
    JSON.stringify(missing)
  )

  // 5. THE FENCE: a pane rebound to a newer runtime survives a stale reap.
  const rebound = await newSurface('t08115-rebound')
  created.push(rebound)
  await stamp(rebound, {
    hrc_role: 'headless-agent-pane',
    hrc_runtime_id: 'rt-t08115-NEW',
    hrc_window_key: 'default',
  })
  const fenced = await manager.reapHeadlessAgentPane(rebound, 'rt-t08115-OLD')
  const fencedSurvived = await exists(rebound)
  check(
    'FENCE: a pane rebound to a newer runtime survives a stale reap',
    fenced.status === 'skipped' &&
      fenced.reason === 'runtime_rebound' &&
      fenced.observedRuntimeId === 'rt-t08115-NEW' &&
      fenced.requiredRuntimeId === 'rt-t08115-OLD' &&
      fencedSurvived,
    `${JSON.stringify(fenced)} surfaceSurvived=${fencedSurvived}`
  )
} finally {
  for (const surfaceId of created) {
    await ghostmux(['kill-surface', '-t', surfaceId]).catch(() => undefined)
  }
}

console.log(
  `\n${failures.length === 0 ? 'all live checks passed' : `FAILED: ${failures.join(', ')}`}`
)
process.exit(failures.length === 0 ? 0 : 1)
