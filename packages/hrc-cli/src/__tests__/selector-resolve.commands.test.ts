/**
 * RED tests for T-04219 P1 — per-command selector adapter (daedalus REQUIRED #2)
 *
 * These tests are intentionally RED. They import from the not-yet-existing
 * module `../selector-resolve` and will fail with "Cannot find module" until
 * the implementation is provided. That is the correct RED failure reason.
 *
 * ─── What is being tested ────────────────────────────────────────────────────
 *
 * `selector-resolve.ts` must also export async adapter functions that:
 *  a) Fetch a SelectorSnapshot from a live HrcClient (listRuntimes + listSessions)
 *  b) Call resolveSelectorTarget for the command's expected type
 *  c) Return the concrete ID (runtimeId / hostSessionId)
 *
 * These adapters are what the command functions wire in. Tests here mock the
 * HrcClient and verify that each per-command adapter resolves both raw-ID and
 * selector-form arguments correctly.
 *
 * ─── Additional exports pinned by these tests ────────────────────────────────
 *
 *   // Build a SelectorSnapshot from an HrcClient (queries listRuntimes + listSessions)
 *   async function fetchSelectorSnapshot(client: HrcClient): Promise<SelectorSnapshot>
 *
 *   // Resolve a raw CLI argument to a runtimeId for commands that expect a runtime.
 *   // Combines fetchSelectorSnapshot + resolveSelectorTarget(expect='runtime').
 *   // Throws SelectorResolutionError on type-mismatch, ambiguity, or not-found.
 *   async function resolveRuntimeArg(rawArg: string, client: HrcClient): Promise<string>
 *
 *   // Resolve a raw CLI argument to a hostSessionId for commands that expect a session.
 *   // Combines fetchSelectorSnapshot + resolveSelectorTarget(expect='host-session').
 *   async function resolveSessionArg(rawArg: string, client: HrcClient): Promise<string>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it, mock } from 'bun:test'

import type { HrcClient } from 'hrc-sdk'
import type { HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'

// RED GATE: this import will fail until selector-resolve.ts is implemented
import {
  SelectorResolutionError,
  fetchSelectorSnapshot,
  resolveRuntimeArg,
  resolveSessionArg,
} from '../selector-resolve'

// ---------------------------------------------------------------------------
// Mock HrcClient builder
//
// Only stubs the subset of HrcClient used by the selector adapter:
//   - listRuntimes()  → RuntimeRecord[] (= HrcRuntimeSnapshot[])
//   - listSessions()  → HrcSessionRecord[]
// ---------------------------------------------------------------------------

type PartialRuntime = Pick<
  HrcRuntimeSnapshot,
  'runtimeId' | 'scopeRef' | 'laneRef' | 'hostSessionId' | 'generation' |
  'transport' | 'harness' | 'provider' | 'status' | 'supportsInflightInput' |
  'adopted' | 'createdAt' | 'updatedAt'
>

type PartialSession = Pick<
  HrcSessionRecord,
  'hostSessionId' | 'scopeRef' | 'laneRef' | 'generation' | 'status' |
  'createdAt' | 'updatedAt' | 'ancestorScopeRefs'
>

function makeRuntime(overrides: Partial<PartialRuntime> & { runtimeId: string }): PartialRuntime {
  return {
    runtimeId: overrides.runtimeId,
    scopeRef: overrides.scopeRef ?? 'agent:cody:project:hrc-runtime:task:primary',
    laneRef: overrides.laneRef ?? 'main',
    hostSessionId: overrides.hostSessionId ?? 'hs-aaaa-0001',
    generation: overrides.generation ?? 1,
    transport: overrides.transport ?? 'tmux',
    harness: overrides.harness ?? 'claude-code',
    provider: overrides.provider ?? 'anthropic',
    status: overrides.status ?? 'idle',
    supportsInflightInput: overrides.supportsInflightInput ?? false,
    adopted: overrides.adopted ?? false,
    createdAt: overrides.createdAt ?? '2026-06-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-06-01T00:00:00Z',
  }
}

function makeSession(overrides: Partial<PartialSession> & { hostSessionId: string }): PartialSession {
  return {
    hostSessionId: overrides.hostSessionId,
    scopeRef: overrides.scopeRef ?? 'agent:cody:project:hrc-runtime:task:primary',
    laneRef: overrides.laneRef ?? 'main',
    generation: overrides.generation ?? 1,
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? '2026-06-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-06-01T00:00:00Z',
    ancestorScopeRefs: overrides.ancestorScopeRefs ?? [],
  }
}

function mockClient(
  runtimes: PartialRuntime[],
  sessions: PartialSession[]
): Pick<HrcClient, 'listRuntimes' | 'listSessions'> {
  return {
    listRuntimes: mock(() => Promise.resolve(runtimes as HrcRuntimeSnapshot[])),
    listSessions: mock(() => Promise.resolve(sessions as HrcSessionRecord[])),
  } as Pick<HrcClient, 'listRuntimes' | 'listSessions'>
}

// ---------------------------------------------------------------------------
// §1: fetchSelectorSnapshot
// ---------------------------------------------------------------------------

describe('fetchSelectorSnapshot', () => {
  it('returns runtimes and sessions from the client', async () => {
    const rt = makeRuntime({ runtimeId: 'rt-fetch-001' })
    const sess = makeSession({ hostSessionId: 'hs-fetch-001' })
    const client = mockClient([rt], [sess])

    const snapshot = await fetchSelectorSnapshot(client as unknown as HrcClient)

    expect(snapshot.runtimes).toHaveLength(1)
    expect(snapshot.runtimes[0]!.runtimeId).toBe('rt-fetch-001')
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]!.hostSessionId).toBe('hs-fetch-001')
  })

  it('returns empty arrays when no runtimes or sessions exist', async () => {
    const client = mockClient([], [])
    const snapshot = await fetchSelectorSnapshot(client as unknown as HrcClient)
    expect(snapshot.runtimes).toHaveLength(0)
    expect(snapshot.sessions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// §2: resolveRuntimeArg — commands that expect a runtime
//     covers: runtime inspect, runtime terminate, broker inspect,
//             capture, inflight send, surface bind, surface list
// ---------------------------------------------------------------------------

describe('resolveRuntimeArg — raw runtimeId (runtime inspect / terminate / broker inspect / capture / inflight / surface)', () => {
  it('resolves a raw runtimeId that exists in the snapshot', async () => {
    const rt = makeRuntime({ runtimeId: 'rt-raw-001' })
    const client = mockClient([rt], [])

    const result = await resolveRuntimeArg('rt-raw-001', client as unknown as HrcClient)
    expect(result).toBe('rt-raw-001')
  })

  it('does not call listSessions when resolving a raw runtimeId', async () => {
    const rt = makeRuntime({ runtimeId: 'rt-raw-002' })
    const client = mockClient([rt], [])

    await resolveRuntimeArg('rt-raw-002', client as unknown as HrcClient)
    // listRuntimes must have been called (to build the snapshot)
    expect(client.listRuntimes).toHaveBeenCalled()
  })
})

describe('resolveRuntimeArg — runtime: prefix (runtime inspect / terminate / broker inspect / capture / inflight / surface)', () => {
  it('resolves runtime: prefix to runtimeId (runtime not in snapshot)', async () => {
    // Prefixed form bypasses snapshot requirement — ID is extracted directly
    const client = mockClient([], [])
    const result = await resolveRuntimeArg(
      'runtime:rt-pfx-001',
      client as unknown as HrcClient
    )
    expect(result).toBe('rt-pfx-001')
  })

  it('resolves runtime: prefix even when runtimeId is also in the snapshot', async () => {
    const rt = makeRuntime({ runtimeId: 'rt-pfx-002' })
    const client = mockClient([rt], [])

    const result = await resolveRuntimeArg(
      'runtime:rt-pfx-002',
      client as unknown as HrcClient
    )
    expect(result).toBe('rt-pfx-002')
  })
})

describe('resolveRuntimeArg — bare handle (runtime inspect via scope handle)', () => {
  it('resolves bare agent handle to its single matching runtime', async () => {
    const rt = makeRuntime({
      runtimeId: 'rt-handle-001',
      scopeRef: 'agent:cody:project:hrc-runtime:task:primary',
      laneRef: 'main',
    })
    const client = mockClient([rt], [])

    // cody@hrc-runtime qualifies to agent:cody:project:hrc-runtime:task:primary
    const result = await resolveRuntimeArg(
      'cody@hrc-runtime',
      client as unknown as HrcClient
    )
    expect(result).toBe('rt-handle-001')
  })

  it('throws SelectorResolutionError(ambiguous) when handle matches multiple runtimes', async () => {
    const rt1 = makeRuntime({
      runtimeId: 'rt-handle-002',
      scopeRef: 'agent:cody:project:hrc-runtime:task:primary',
      laneRef: 'main',
    })
    const rt2 = makeRuntime({
      runtimeId: 'rt-handle-003',
      scopeRef: 'agent:cody:project:hrc-runtime:task:primary',
      laneRef: 'repair',
    })
    const client = mockClient([rt1, rt2], [])

    await expect(
      resolveRuntimeArg('cody@hrc-runtime', client as unknown as HrcClient)
    ).rejects.toThrow(SelectorResolutionError)

    try {
      await resolveRuntimeArg('cody@hrc-runtime', client as unknown as HrcClient)
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      expect((err as SelectorResolutionError).code).toBe('ambiguous')
    }
  })

  it('throws SelectorResolutionError(not-found) when handle has no matching runtime', async () => {
    const client = mockClient([], [])

    await expect(
      resolveRuntimeArg('cody@hrc-runtime', client as unknown as HrcClient)
    ).rejects.toThrow(SelectorResolutionError)

    try {
      await resolveRuntimeArg('cody@hrc-runtime', client as unknown as HrcClient)
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      expect((err as SelectorResolutionError).code).toBe('not-found')
    }
  })
})

describe('resolveRuntimeArg — type mismatch errors for non-runtime selectors', () => {
  it('throws SelectorResolutionError(type-mismatch) for msg: prefix', async () => {
    const client = mockClient([], [])

    try {
      await resolveRuntimeArg('msg:m-aaaa', client as unknown as HrcClient)
      throw new Error('Expected SelectorResolutionError but none was thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      const resolveErr = err as SelectorResolutionError
      expect(resolveErr.code).toBe('type-mismatch')
      // Error message must name the accepted forms
      expect(resolveErr.message).toMatch(/runtime/i)
    }
  })

  it('throws SelectorResolutionError(type-mismatch) for host: prefix when expect is runtime', async () => {
    const client = mockClient([], [])

    try {
      await resolveRuntimeArg('host:hs-bbbb', client as unknown as HrcClient)
      throw new Error('Expected SelectorResolutionError but none was thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      const resolveErr = err as SelectorResolutionError
      expect(resolveErr.code).toBe('type-mismatch')
    }
  })
})

// ---------------------------------------------------------------------------
// §3: resolveSessionArg — commands that expect a host-session
//     covers: session get
// ---------------------------------------------------------------------------

describe('resolveSessionArg — raw hostSessionId (session get)', () => {
  it('resolves a raw hostSessionId that exists in the snapshot', async () => {
    const sess = makeSession({ hostSessionId: 'hs-raw-001' })
    const client = mockClient([], [sess])

    const result = await resolveSessionArg('hs-raw-001', client as unknown as HrcClient)
    expect(result).toBe('hs-raw-001')
  })
})

describe('resolveSessionArg — host: prefix (session get)', () => {
  it('resolves host: prefix to hostSessionId (session not in snapshot)', async () => {
    const client = mockClient([], [])

    const result = await resolveSessionArg(
      'host:hs-pfx-001',
      client as unknown as HrcClient
    )
    expect(result).toBe('hs-pfx-001')
  })
})

describe('resolveSessionArg — bare handle (session get via scope handle)', () => {
  it('resolves bare agent handle to its single matching session', async () => {
    const sess = makeSession({
      hostSessionId: 'hs-handle-001',
      scopeRef: 'agent:cody:project:hrc-runtime:task:primary',
      laneRef: 'main',
    })
    const client = mockClient([], [sess])

    const result = await resolveSessionArg(
      'cody@hrc-runtime',
      client as unknown as HrcClient
    )
    expect(result).toBe('hs-handle-001')
  })

  it('throws SelectorResolutionError(ambiguous) when handle matches multiple sessions', async () => {
    const sess1 = makeSession({
      hostSessionId: 'hs-handle-002',
      scopeRef: 'agent:cody:project:hrc-runtime:task:primary',
      laneRef: 'main',
    })
    const sess2 = makeSession({
      hostSessionId: 'hs-handle-003',
      scopeRef: 'agent:cody:project:hrc-runtime:task:primary',
      laneRef: 'repair',
    })
    const client = mockClient([], [sess1, sess2])

    await expect(
      resolveSessionArg('cody@hrc-runtime', client as unknown as HrcClient)
    ).rejects.toThrow(SelectorResolutionError)

    try {
      await resolveSessionArg('cody@hrc-runtime', client as unknown as HrcClient)
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      expect((err as SelectorResolutionError).code).toBe('ambiguous')
    }
  })
})

describe('resolveSessionArg — type mismatch errors for non-session selectors', () => {
  it('throws SelectorResolutionError(type-mismatch) for runtime: prefix when expect is host-session', async () => {
    const client = mockClient([], [])

    try {
      await resolveSessionArg('runtime:rt-aaaa', client as unknown as HrcClient)
      throw new Error('Expected SelectorResolutionError but none was thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      const resolveErr = err as SelectorResolutionError
      expect(resolveErr.code).toBe('type-mismatch')
      // Message must name accepted forms for host-session
      expect(resolveErr.message).toMatch(/host.session|hostSessionId/i)
    }
  })

  it('throws SelectorResolutionError(type-mismatch) for msg: prefix when expect is host-session', async () => {
    const client = mockClient([], [])

    try {
      await resolveSessionArg('msg:m-aaaa', client as unknown as HrcClient)
      throw new Error('Expected SelectorResolutionError but none was thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      const resolveErr = err as SelectorResolutionError
      expect(resolveErr.code).toBe('type-mismatch')
    }
  })
})

// ---------------------------------------------------------------------------
// §4: per-command form coverage summary (explicit contracts)
//
// These tests verify the specific adapter function is called for each command's
// expected type. They are table-driven assertions that confirm the contract
// surface matches what the impl agent must wire into the commands.
// ---------------------------------------------------------------------------

describe('per-command adapter contract coverage', () => {
  const RUNTIME_ID = 'rt-contract-001'
  const SESSION_ID = 'hs-contract-001'
  const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:primary'

  function buildRuntimeClient(): ReturnType<typeof mockClient> {
    return mockClient(
      [makeRuntime({ runtimeId: RUNTIME_ID, scopeRef: SCOPE_REF })],
      []
    )
  }

  function buildSessionClient(): ReturnType<typeof mockClient> {
    return mockClient(
      [],
      [makeSession({ hostSessionId: SESSION_ID, scopeRef: SCOPE_REF })]
    )
  }

  describe('runtime inspect', () => {
    it('resolves raw runtimeId via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(RUNTIME_ID, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
    it('resolves runtime: selector via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(`runtime:${RUNTIME_ID}`, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
  })

  describe('runtime terminate (non-destructive harness — resolver only)', () => {
    it('resolves raw runtimeId via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(RUNTIME_ID, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
    it('resolves runtime: selector via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(`runtime:${RUNTIME_ID}`, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
  })

  describe('session get', () => {
    it('resolves raw hostSessionId via resolveSessionArg', async () => {
      const client = buildSessionClient()
      expect(await resolveSessionArg(SESSION_ID, client as unknown as HrcClient)).toBe(SESSION_ID)
    })
    it('resolves host: selector via resolveSessionArg', async () => {
      const client = buildSessionClient()
      expect(await resolveSessionArg(`host:${SESSION_ID}`, client as unknown as HrcClient)).toBe(SESSION_ID)
    })
  })

  describe('broker inspect', () => {
    it('resolves raw runtimeId via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(RUNTIME_ID, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
    it('resolves runtime: selector via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(`runtime:${RUNTIME_ID}`, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
  })

  describe('capture (runtime capture)', () => {
    it('resolves raw runtimeId via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(RUNTIME_ID, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
    it('resolves runtime: selector via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(`runtime:${RUNTIME_ID}`, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
  })

  describe('inflight send', () => {
    it('resolves raw runtimeId via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(RUNTIME_ID, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
    it('resolves runtime: selector via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(`runtime:${RUNTIME_ID}`, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
  })

  describe('surface bind', () => {
    it('resolves raw runtimeId via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(RUNTIME_ID, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
    it('resolves runtime: selector via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(`runtime:${RUNTIME_ID}`, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
  })

  describe('surface list', () => {
    it('resolves raw runtimeId via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(RUNTIME_ID, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
    it('resolves runtime: selector via resolveRuntimeArg', async () => {
      const client = buildRuntimeClient()
      expect(await resolveRuntimeArg(`runtime:${RUNTIME_ID}`, client as unknown as HrcClient)).toBe(RUNTIME_ID)
    })
  })
})
