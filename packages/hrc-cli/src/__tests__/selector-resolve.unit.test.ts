/**
 * RED tests for T-04219 P1 — Selector Resolver Unit (daedalus REQUIRED #1)
 *
 * These tests are intentionally RED. They import from the not-yet-existing
 * module `../selector-resolve` and will fail with "Cannot find module" until
 * the implementation is provided. That is the correct RED failure reason.
 *
 * ─── Contract pinned by these tests ──────────────────────────────────────────
 *
 * Module: packages/hrc-cli/src/selector-resolve.ts
 *
 * Exports:
 *
 *   type SelectorTargetKind = 'runtime' | 'host-session' | 'message' | 'bridge'
 *
 *   type RuntimeSnapshot = {
 *     runtimeId: string
 *     scopeRef:  string
 *     laneRef:   string
 *   }
 *
 *   type SessionSnapshot = {
 *     hostSessionId: string
 *     scopeRef:      string
 *     laneRef:       string
 *   }
 *
 *   type SelectorSnapshot = {
 *     runtimes: RuntimeSnapshot[]
 *     sessions: SessionSnapshot[]
 *   }
 *
 *   type ResolvedRuntime = { kind: 'runtime';      runtimeId:     string }
 *   type ResolvedSession = { kind: 'host-session'; hostSessionId: string }
 *   type ResolvedTarget  = ResolvedRuntime | ResolvedSession
 *
 *   class SelectorResolutionError extends Error {
 *     code: 'type-mismatch' | 'ambiguous' | 'not-found' | 'parse-error'
 *     // error.message MUST name the accepted selector forms when code='type-mismatch'
 *   }
 *
 *   function resolveSelectorTarget(
 *     rawArg:  string,
 *     opts: {
 *       expect:   SelectorTargetKind
 *       snapshot: SelectorSnapshot
 *     }
 *   ): ResolvedTarget
 *
 * ─── Resolution invariant (daedalus INVARIANT) ───────────────────────────────
 *
 *   1. If rawArg is an exact native raw ID of the expected type found in the
 *      snapshot → use it directly (raw runtimeId beats bare-handle parse).
 *   2. Else: parse via hrc-core parseSelector.
 *      – Prefixed forms (runtime: / host: / session: / msg: / seq: / scope:)
 *        are resolved by prefix; the embedded ID is extracted directly.
 *      – Bare handle/scope: resolved to the scope's active runtime/session
 *        ONLY after no native raw-ID match.
 *   3. Ambiguity (bare handle matches >1 runtime) → FATAL SelectorResolutionError
 *      (code='ambiguous'). No silent "latest" heuristic.
 *   4. Type mismatch (e.g. msg: prefix with expect='runtime') → FATAL
 *      SelectorResolutionError (code='type-mismatch') whose message names the
 *      accepted forms.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from 'bun:test'

// RED GATE: this import will fail until selector-resolve.ts is implemented
import { SelectorResolutionError, resolveSelectorTarget } from '../selector-resolve'

import type { SelectorSnapshot } from '../selector-resolve'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const RUNTIME_A = {
  runtimeId: 'rt-aaaaaaaa-0000-0000-0000-000000000001',
  scopeRef: 'agent:cody:project:hrc-runtime:task:T-04000',
  laneRef: 'main',
}

const RUNTIME_B = {
  runtimeId: 'rt-bbbbbbbb-0000-0000-0000-000000000002',
  scopeRef: 'agent:cody:project:hrc-runtime:task:T-04000',
  laneRef: 'repair',
}

const SESSION_A = {
  hostSessionId: 'hs-aaaaaaaa-0000-0000-0000-000000000001',
  scopeRef: 'agent:cody:project:hrc-runtime:task:T-04000',
  laneRef: 'main',
}

function snapshotWith(
  runtimes: (typeof RUNTIME_A)[],
  sessions?: (typeof SESSION_A)[]
): SelectorSnapshot {
  return {
    runtimes,
    sessions: sessions ?? [],
  }
}

// ---------------------------------------------------------------------------
// §1: raw runtimeId beats bare-handle parse
// ---------------------------------------------------------------------------

describe('resolveSelectorTarget — raw runtimeId beats bare-handle parse', () => {
  it('returns the runtime directly when rawArg matches an existing runtimeId in the snapshot', () => {
    const snapshot = snapshotWith([RUNTIME_A])
    const result = resolveSelectorTarget(RUNTIME_A.runtimeId, {
      expect: 'runtime',
      snapshot,
    })
    expect(result).toEqual({ kind: 'runtime', runtimeId: RUNTIME_A.runtimeId })
  })

  it('does NOT attempt handle parsing when the raw token is a valid runtimeId in the snapshot', () => {
    // rt-... tokens look nothing like agent handles, but the invariant says
    // raw-id match happens first regardless of token shape.
    const snapshot = snapshotWith([RUNTIME_A, RUNTIME_B])
    const resultA = resolveSelectorTarget(RUNTIME_A.runtimeId, {
      expect: 'runtime',
      snapshot,
    })
    expect(resultA).toEqual({ kind: 'runtime', runtimeId: RUNTIME_A.runtimeId })

    const resultB = resolveSelectorTarget(RUNTIME_B.runtimeId, {
      expect: 'runtime',
      snapshot,
    })
    expect(resultB).toEqual({ kind: 'runtime', runtimeId: RUNTIME_B.runtimeId })
  })

  it('raw hostSessionId beats bare-handle parse when expect is host-session', () => {
    const snapshot = snapshotWith([], [SESSION_A])
    const result = resolveSelectorTarget(SESSION_A.hostSessionId, {
      expect: 'host-session',
      snapshot,
    })
    expect(result).toEqual({ kind: 'host-session', hostSessionId: SESSION_A.hostSessionId })
  })
})

// ---------------------------------------------------------------------------
// §2: prefixed `runtime:` selector resolves by prefix
// ---------------------------------------------------------------------------

describe('resolveSelectorTarget — prefixed runtime: resolves', () => {
  it('extracts runtimeId from runtime: prefix', () => {
    const runtimeId = 'rt-cccccccc-0000-0000-0000-000000000003'
    // The runtime is NOT in the snapshot — prefixed forms bypass snapshot lookup
    const snapshot = snapshotWith([])
    const result = resolveSelectorTarget(`runtime:${runtimeId}`, {
      expect: 'runtime',
      snapshot,
    })
    expect(result).toEqual({ kind: 'runtime', runtimeId })
  })

  it('extracts runtimeId from runtime: prefix even when the same ID is in the snapshot', () => {
    const snapshot = snapshotWith([RUNTIME_A])
    const result = resolveSelectorTarget(`runtime:${RUNTIME_A.runtimeId}`, {
      expect: 'runtime',
      snapshot,
    })
    expect(result).toEqual({ kind: 'runtime', runtimeId: RUNTIME_A.runtimeId })
  })

  it('extracts hostSessionId from host: prefix when expect is host-session', () => {
    const hostSessionId = 'hs-cccccccc-0000-0000-0000-000000000003'
    const snapshot = snapshotWith([])
    const result = resolveSelectorTarget(`host:${hostSessionId}`, {
      expect: 'host-session',
      snapshot,
    })
    expect(result).toEqual({ kind: 'host-session', hostSessionId })
  })
})

// ---------------------------------------------------------------------------
// §3: type mismatch errors name accepted forms
// ---------------------------------------------------------------------------

describe('resolveSelectorTarget — type mismatch names accepted forms', () => {
  it('throws SelectorResolutionError(code=type-mismatch) for msg: prefix when expect is runtime', () => {
    const snapshot = snapshotWith([])
    expect(() => resolveSelectorTarget('msg:m-aaaaa', { expect: 'runtime', snapshot })).toThrow(
      SelectorResolutionError
    )

    try {
      resolveSelectorTarget('msg:m-aaaaa', { expect: 'runtime', snapshot })
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      const resolveErr = err as SelectorResolutionError
      expect(resolveErr.code).toBe('type-mismatch')
      // The error message MUST name the accepted forms for this command type
      expect(resolveErr.message).toMatch(/runtime/i)
      // It should name what was received too
      expect(resolveErr.message).toMatch(/msg/i)
    }
  })

  it('throws SelectorResolutionError(code=type-mismatch) for seq: prefix when expect is runtime', () => {
    const snapshot = snapshotWith([])
    try {
      resolveSelectorTarget('seq:42', { expect: 'runtime', snapshot })
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      const resolveErr = err as SelectorResolutionError
      expect(resolveErr.code).toBe('type-mismatch')
      expect(resolveErr.message).toMatch(/runtime/i)
    }
  })

  it('throws SelectorResolutionError(code=type-mismatch) for runtime: prefix when expect is host-session', () => {
    const snapshot = snapshotWith([], [SESSION_A])
    try {
      resolveSelectorTarget('runtime:rt-aaaa', { expect: 'host-session', snapshot })
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      const resolveErr = err as SelectorResolutionError
      expect(resolveErr.code).toBe('type-mismatch')
      expect(resolveErr.message).toMatch(/host.session|hostSessionId/i)
    }
  })

  it('error message names both what was given and what was expected', () => {
    const snapshot = snapshotWith([])
    try {
      resolveSelectorTarget('msg:m-xyz', { expect: 'runtime', snapshot })
    } catch (err) {
      const resolveErr = err as SelectorResolutionError
      // Must name received kind AND accepted kinds so the operator knows what to fix
      expect(resolveErr.message.length).toBeGreaterThan(10)
      // accepted forms should appear — at minimum 'runtime:' or 'runtime'
      expect(resolveErr.message).toContain('runtime')
    }
  })
})

// ---------------------------------------------------------------------------
// §4: ambiguous handle → fatal error
// ---------------------------------------------------------------------------

describe('resolveSelectorTarget — ambiguous handle is a FATAL error', () => {
  it('throws SelectorResolutionError(code=ambiguous) when two runtimes match the same bare handle', () => {
    // Both RUNTIME_A and RUNTIME_B share scopeRef but differ only by laneRef.
    // A bare handle that resolves to the same scopeRef (no lane specified)
    // → both match → ambiguous.
    const _snapshot = snapshotWith([RUNTIME_A, RUNTIME_B])
    // cody@hrc-runtime resolves to agent:cody:project:hrc-runtime:task:primary
    // or similar — the exact qualified form depends on resolveQualifiedScopeInput.
    // We build a snapshot where two runtimes have the same scopeRef but differ in laneRef,
    // which produces an ambiguous result when no lane is given in the bare handle.
    const RUNTIME_A2 = {
      runtimeId: 'rt-dddddddd-0000-0000-0000-000000000004',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:primary',
      laneRef: 'main',
    }
    const RUNTIME_A3 = {
      runtimeId: 'rt-eeeeeeee-0000-0000-0000-000000000005',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:primary',
      laneRef: 'repair',
    }
    const ambiguousSnapshot = snapshotWith([RUNTIME_A2, RUNTIME_A3])

    expect(() =>
      // bare handle resolving to scopeRef that matches two different laneRefs
      resolveSelectorTarget('smokey@hrc-runtime', {
        expect: 'runtime',
        snapshot: ambiguousSnapshot,
      })
    ).toThrow(SelectorResolutionError)

    try {
      resolveSelectorTarget('smokey@hrc-runtime', {
        expect: 'runtime',
        snapshot: ambiguousSnapshot,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      const resolveErr = err as SelectorResolutionError
      expect(resolveErr.code).toBe('ambiguous')
      // Error must name what it found so the operator can use a specific selector
      expect(resolveErr.message).toMatch(/ambig|multiple|more than one/i)
    }
  })

  it('does NOT throw ambiguous when exactly one runtime matches the bare handle', () => {
    const RUNTIME_UNIQ = {
      runtimeId: 'rt-ffffffff-0000-0000-0000-000000000006',
      scopeRef: 'agent:smokey:project:hrc-runtime:task:primary',
      laneRef: 'main',
    }
    const snapshot = snapshotWith([RUNTIME_UNIQ])

    // Should resolve successfully to RUNTIME_UNIQ
    const result = resolveSelectorTarget('smokey@hrc-runtime', {
      expect: 'runtime',
      snapshot,
    })
    expect(result).toEqual({ kind: 'runtime', runtimeId: RUNTIME_UNIQ.runtimeId })
  })

  it('throws SelectorResolutionError(code=not-found) when bare handle has no matching runtime', () => {
    // Empty snapshot — no runtimes match cody@hrc-runtime
    const snapshot = snapshotWith([])
    expect(() =>
      resolveSelectorTarget('cody@hrc-runtime', { expect: 'runtime', snapshot })
    ).toThrow(SelectorResolutionError)

    try {
      resolveSelectorTarget('cody@hrc-runtime', { expect: 'runtime', snapshot })
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorResolutionError)
      const resolveErr = err as SelectorResolutionError
      expect(resolveErr.code).toBe('not-found')
    }
  })
})

// ---------------------------------------------------------------------------
// §5: scope: selector resolves to scope's active runtime
// ---------------------------------------------------------------------------

describe('resolveSelectorTarget — scope: prefix resolves to active runtime', () => {
  it('resolves scope: prefix to the single runtime with matching scopeRef', () => {
    const RUNTIME_SCOPED = {
      runtimeId: 'rt-11111111-0000-0000-0000-000000000007',
      scopeRef: 'agent:larry:project:workboard:task:primary',
      laneRef: 'main',
    }
    const snapshot = snapshotWith([RUNTIME_SCOPED])

    const result = resolveSelectorTarget('scope:agent:larry:project:workboard:task:primary', {
      expect: 'runtime',
      snapshot,
    })
    expect(result).toEqual({ kind: 'runtime', runtimeId: RUNTIME_SCOPED.runtimeId })
  })

  it('throws ambiguous when scope: matches multiple runtimes', () => {
    const RT1 = {
      runtimeId: 'rt-22222222-0000-0000-0000-000000000008',
      scopeRef: 'agent:larry:project:workboard:task:primary',
      laneRef: 'main',
    }
    const RT2 = {
      runtimeId: 'rt-33333333-0000-0000-0000-000000000009',
      scopeRef: 'agent:larry:project:workboard:task:primary',
      laneRef: 'repair',
    }
    const snapshot = snapshotWith([RT1, RT2])

    expect(() =>
      resolveSelectorTarget('scope:agent:larry:project:workboard:task:primary', {
        expect: 'runtime',
        snapshot,
      })
    ).toThrow(SelectorResolutionError)

    try {
      resolveSelectorTarget('scope:agent:larry:project:workboard:task:primary', {
        expect: 'runtime',
        snapshot,
      })
    } catch (err) {
      const resolveErr = err as SelectorResolutionError
      expect(resolveErr.code).toBe('ambiguous')
    }
  })
})
