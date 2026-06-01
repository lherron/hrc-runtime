import { describe, expect, it } from 'bun:test'

import { selectDispatchInteractiveRuntime, selectLatestInteractiveRuntime } from '../index'

describe('selectLatestInteractiveRuntime', () => {
  it('returns the newest interactive runtime even when it is stale', () => {
    const olderReady = { id: 'older-ready', transport: 'tmux', status: 'ready' }
    const newerStale = { id: 'newer-stale', transport: 'tmux', status: 'stale' }

    expect(selectLatestInteractiveRuntime([olderReady, newerStale])).toBe(newerStale)
  })

  it('ignores non-interactive runtimes', () => {
    expect(
      selectLatestInteractiveRuntime([
        { id: 'headless', transport: 'headless', status: 'ready' },
        { id: 'sdk', transport: 'sdk', status: 'ready' },
      ])
    ).toBeNull()
  })
})

describe('selectDispatchInteractiveRuntime', () => {
  it('prefers the newest available interactive runtime over a newer stale row', () => {
    const olderReady = { id: 'older-ready', transport: 'tmux', status: 'ready' }
    const newerStale = { id: 'newer-stale', transport: 'tmux', status: 'stale' }

    expect(selectDispatchInteractiveRuntime([olderReady, newerStale])).toBe(olderReady)
  })

  it('falls back to the newest interactive runtime when none are available', () => {
    const olderStale = { id: 'older-stale', transport: 'tmux', status: 'stale' }
    const newerDead = { id: 'newer-dead', transport: 'ghostty', status: 'dead' }

    expect(selectDispatchInteractiveRuntime([olderStale, newerDead])).toBe(newerDead)
  })

  it('ignores non-interactive runtimes', () => {
    expect(
      selectDispatchInteractiveRuntime([
        { id: 'headless', transport: 'headless', status: 'ready' },
        { id: 'sdk', transport: 'sdk', status: 'ready' },
      ])
    ).toBeNull()
  })
})
