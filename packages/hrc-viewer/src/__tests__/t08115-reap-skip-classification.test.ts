import { describe, expect, it } from 'bun:test'

import { GhostmuxManager } from '../ghostmux'

/**
 * T-08115. `reapHeadlessAgentPane` reported FOUR different situations as one
 * `not_agent_pane`: a genuine refusal, a pane that had already closed itself, a
 * probe that timed out, and a malformed answer. The log line could not tell a
 * correct refusal from a lost probe, so a reader had no way to know whether a
 * window had been stranded or had simply gone away on its own.
 *
 * These tests pin the discrimination. The fake models the REAL ghostmux wire
 * behaviour observed against the installed binary on 2026-09-06:
 *
 *   $ ghostmux metadata get -t 00000000-0000-0000-0000-000000000000 --json
 *   error: can't find terminal: 00000000-... (expected exact UUID, title, ...)
 *   EXIT=1
 *
 * i.e. an unresolvable target is a non-zero exit, NOT empty metadata.
 */

type FakeOptions = {
  /** Surfaces ghostmux will resolve, with their surface-scope metadata. */
  surfaces: Record<string, Record<string, unknown>>
  /** Surface ids whose `metadata get` fails with something other than not-found. */
  probeFails?: Record<string, string>
  /** Make `list-surfaces` itself fail, so existence is unanswerable. */
  listFails?: boolean
  /** Return metadata that is not an object at all. */
  malformed?: Set<string>
}

function makeGhostmux(options: FakeOptions) {
  const killed: string[] = []
  const runner = async (args: string[]) => {
    if (args[0] === 'list-surfaces') {
      if (options.listFails === true) throw new Error('ghostmux list-surfaces --json timed out')
      const live = Object.keys(options.surfaces).filter((id) => !killed.includes(id))
      return { stdout: JSON.stringify({ terminals: live.map((id) => ({ id })) }), stderr: '' }
    }
    if (args[0] === 'metadata' && args[1] === 'get') {
      const id = args[3] ?? ''
      const failure = options.probeFails?.[id]
      if (failure !== undefined) throw new Error(failure)
      if (!(id in options.surfaces) || killed.includes(id)) {
        throw new Error(`error: can't find terminal: ${id} (expected exact UUID, title, ...)`)
      }
      if (options.malformed?.has(id) === true) return { stdout: JSON.stringify(null), stderr: '' }
      return { stdout: JSON.stringify({ data: options.surfaces[id] }), stderr: '' }
    }
    if (args[0] === 'kill-surface') {
      killed.push(args[2] ?? '')
      return { stdout: '{}', stderr: '' }
    }
    if (args[0] === 'list-windows') throw new Error('server does not support the windows API')
    return { stdout: '{}', stderr: '' }
  }
  return { runner, killed }
}

const AGENT_PANE = {
  hrc_role: 'headless-agent-pane',
  hrc_runtime_id: 'rt-1',
  hrc_tab_key: 'task:T-08115',
  hrc_window_key: 'default',
}

describe('T-08115 reap skip classification', () => {
  it('reaps the pane it owns — the classification change does not disarm the reaper', async () => {
    const fake = makeGhostmux({ surfaces: { 'surf-a': AGENT_PANE } })
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    expect(await manager.reapHeadlessAgentPane('surf-a', 'rt-1')).toMatchObject({
      status: 'reaped',
      surfaceId: 'surf-a',
    })
    expect(fake.killed).toEqual(['surf-a'])
  })

  it('REFUSES a live pane that is genuinely not ours, and says what it saw', async () => {
    // The positive control the fix must not break: a real, resolvable surface
    // that belongs to the operator. It must survive.
    const fake = makeGhostmux({
      surfaces: { 'surf-operator': { hrc_role: 'headless-window-anchor' } },
    })
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    expect(await manager.reapHeadlessAgentPane('surf-operator', 'rt-1')).toEqual({
      status: 'skipped',
      reason: 'not_agent_pane',
      observedRole: 'headless-window-anchor',
      requiredRole: 'headless-agent-pane',
    })
    expect(fake.killed).toEqual([])
  })

  it('REFUSES a bare surface carrying no hrc metadata at all', async () => {
    const fake = makeGhostmux({ surfaces: { 'surf-shell': {} } })
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    expect(await manager.reapHeadlessAgentPane('surf-shell', 'rt-1')).toEqual({
      status: 'skipped',
      reason: 'not_agent_pane',
      observedRole: null,
      requiredRole: 'headless-agent-pane',
    })
    expect(fake.killed).toEqual([])
  })

  it('calls an already-closed pane surface_missing, NOT not_agent_pane', async () => {
    // The production case caught live on 2026-09-06 14:15:25Z: the pane had
    // self-closed at the end of its own linger before the reap timer fired.
    const fake = makeGhostmux({ surfaces: {} })
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    const result = await manager.reapHeadlessAgentPane('surf-gone', 'rt-1')
    expect(result).toMatchObject({ status: 'skipped', reason: 'surface_missing' })
    expect((result as { probeError: string }).probeError).toContain("can't find terminal")
  })

  it('calls a failed probe probe_failed and never claims the pane was gone', async () => {
    // A timeout observes NOTHING. Reporting it as `surface_missing` would assert
    // an absence we never established.
    const fake = makeGhostmux({
      surfaces: { 'surf-a': AGENT_PANE },
      probeFails: { 'surf-a': 'ghostmux metadata get -t surf-a --json timed out after 5000ms' },
    })
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    const result = await manager.reapHeadlessAgentPane('surf-a', 'rt-1')
    expect(result).toMatchObject({ status: 'skipped', reason: 'probe_failed' })
    expect((result as { probeError: string }).probeError).toContain('timed out')
    expect(fake.killed).toEqual([])
  })

  it('says probe_failed, not surface_missing, when the CONFIRMING probe also fails', async () => {
    // Both probes are down: existence is unanswerable. An unanswerable question
    // must not be rendered as a definite answer.
    const fake = makeGhostmux({ surfaces: {}, listFails: true })
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    expect(await manager.reapHeadlessAgentPane('surf-gone', 'rt-1')).toMatchObject({
      status: 'skipped',
      reason: 'probe_failed',
    })
  })

  it('says probe_failed when ghostmux answers metadata that is not an object', async () => {
    const fake = makeGhostmux({
      surfaces: { 'surf-a': AGENT_PANE },
      malformed: new Set(['surf-a']),
    })
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    expect(await manager.reapHeadlessAgentPane('surf-a', 'rt-1')).toMatchObject({
      status: 'skipped',
      reason: 'probe_failed',
    })
    expect(fake.killed).toEqual([])
  })

  it('FENCE: a pane rebound to a newer runtime reports both runtime ids', async () => {
    const fake = makeGhostmux({
      surfaces: { 'surf-a': { ...AGENT_PANE, hrc_runtime_id: 'rt-2' } },
    })
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    expect(await manager.reapHeadlessAgentPane('surf-a', 'rt-1')).toEqual({
      status: 'skipped',
      reason: 'runtime_rebound',
      observedRuntimeId: 'rt-2',
      requiredRuntimeId: 'rt-1',
    })
    expect(fake.killed).toEqual([])
  })
})
