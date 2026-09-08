/**
 * T-08294 — the desktop hook helper's fallback ORDER.
 *
 * The helper runs in front of a turn a person is waiting on, so every one of
 * these cases is a real operational state rather than an edge case: the daemon
 * is restarting, the rollout has not been persisted yet, the conversation is a
 * guardian review. What must never happen in ANY of them is the helper making up
 * a friendly name locally — that would be a second permanent address for one
 * conversation, and the whole point of the design is that there is exactly one.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type DesktopScopeCacheEntry,
  desktopScopeCachePath,
  readDesktopScopeCache,
  resolveDesktopHookResult,
  writeDesktopScopeCache,
} from '../launch/desktop-hook'

const NOW = '2026-09-08T12:00:00.000Z'

const CACHED: DesktopScopeCacheEntry = {
  scopeRef: 'agent:stella:project:hrc-ios:task:primary-nova',
  agentId: 'stella',
  projectId: 'hrc-ios',
  slotToken: 'primary-nova',
  laneRef: 'main',
  hostSessionId: 'hsid-1',
  nativeThreadId: '01a08138-7d09-7e12-b8ba-d82b744d9a1e',
  homeIdentity: '/Users/lherron/.codex',
  projectRoot: '/Users/lherron/praesidium/clients/hrc-ios',
  registeredAt: NOW,
  cachedAt: NOW,
}

describe('desktop hook fallback order', () => {
  it('a fresh registration wins over the cache', () => {
    const fresh = { ...CACHED, scopeRef: 'agent:stella:project:hrc-ios:task:primary-comet' }
    const result = resolveDesktopHookResult({
      response: { status: 'registered', cache: fresh },
      cached: CACHED,
      now: NOW,
    })
    expect(result.status === 'registered' && result.source).toBe('hrc')
    expect(result.status === 'registered' && result.cache.scopeRef).toBe(fresh.scopeRef)
  })

  it('an established cache survives a daemon outage', () => {
    const result = resolveDesktopHookResult({ cached: CACHED, now: NOW })
    expect(result.status === 'registered' && result.source).toBe('cache')
    expect(result.status === 'registered' && result.cache.scopeRef).toBe(CACHED.scopeRef)
  })

  it('an established cache also survives a transient pending answer', () => {
    // A daemon that answers `pending` because the rollout has not materialized
    // yet must not retract an address it already issued.
    const result = resolveDesktopHookResult({
      response: { status: 'pending', reason: 'native_metadata_unavailable', detail: 'x' },
      cached: CACHED,
      now: NOW,
    })
    expect(result.status === 'registered' && result.source).toBe('cache')
  })

  it('reports integration_pending — and no scope — when nothing is established', () => {
    const pending = resolveDesktopHookResult({
      response: { status: 'pending', reason: 'spawned_subagent', detail: 'guardian' },
      now: NOW,
    })
    expect(pending.status).toBe('integration_pending')
    expect(pending.status === 'integration_pending' && pending.reason).toBe('spawned_subagent')

    const unreachable = resolveDesktopHookResult({ now: NOW })
    expect(unreachable.status === 'integration_pending' && unreachable.reason).toBe(
      'hrc_unreachable'
    )
    // The property that matters: neither answer carries a scopeRef of any kind.
    expect(JSON.stringify(unreachable)).not.toContain('agent:stella')
  })

  it('never treats a malformed daemon response as an allocation', () => {
    for (const response of [
      null,
      'registered',
      { status: 'registered' },
      { status: 'registered', cache: {} },
    ]) {
      const result = resolveDesktopHookResult({ response, now: NOW })
      expect(result.status).toBe('integration_pending')
    }
  })

  it('round-trips the cache atomically and ignores a truncated one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 't08294-hook-'))
    try {
      const path = desktopScopeCachePath('/unused', CACHED.nativeThreadId, dir)
      await writeDesktopScopeCache(path, CACHED)
      expect((await readDesktopScopeCache(path))?.scopeRef).toBe(CACHED.scopeRef)

      await writeFile(path, '{"scopeRef": "agent:stella')
      // A truncated cache reads as ABSENT, not as a corrupt scope: the helper
      // then asks the daemon again rather than addressing mail to a fragment.
      expect(await readDesktopScopeCache(path)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
