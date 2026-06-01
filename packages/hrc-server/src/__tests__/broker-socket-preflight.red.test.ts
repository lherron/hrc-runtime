/**
 * RED tests (T-01812 / T-01801 Phase 3) — sockaddr_un HARD preflight for the
 * broker Unix IPC socket path.
 *
 * Governing task: T-01812 (parent T-01801, refinement C-03099). The durable
 * interactive broker is reached over a Unix-domain socket. `sockaddr_un.sun_path`
 * is tiny (104 bytes macOS / 108 Linux), so an over-long socket path must FAIL
 * EARLY with a readable error BEFORE any tmux spawn / connect — never as a
 * low-level bind/connect errno later. ASP already ships the budget helpers
 * (assertSocketPathWithinBudget / socketPathByteBudget / socketPathByteLength in
 * spaces-harness-broker-client). What HRC OWES is:
 *   (a) a SHORT, hashed socket-path allocator —
 *       getBrokerIpcSocketPath(options, brokerDriver, runtimeId)
 *         → <runtimeRoot>/bipc/<hash>/b.sock  (short by construction)
 *   (b) a preflight wrapper run BEFORE spawn —
 *       preflightBrokerIpcSocketPath(socketPath): void  (throws when over budget)
 *
 * Neither HRC symbol exists at HEAD, so the namespace references below are
 * `undefined` → clean per-test failures (RED). Tests only.
 */
import { describe, expect, it } from 'bun:test'

import {
  assertSocketPathWithinBudget,
  socketPathByteBudget,
  socketPathByteLength,
} from 'spaces-harness-broker-client'

// Namespace import: the module exists, but the Phase-3 exports referenced below
// do NOT — accessing them yields `undefined` rather than a module-load crash.
import * as tmuxSocket from '../tmux-socket'

type HrcServerOptionsLike = { runtimeRoot: string }

const getBrokerIpcSocketPath = (
  tmuxSocket as unknown as {
    getBrokerIpcSocketPath?: (
      options: HrcServerOptionsLike,
      brokerDriver: string,
      runtimeId: string
    ) => string
  }
).getBrokerIpcSocketPath

const preflightBrokerIpcSocketPath = (
  tmuxSocket as unknown as {
    preflightBrokerIpcSocketPath?: (socketPath: string) => void
  }
).preflightBrokerIpcSocketPath

describe('T-01812 Phase 3 — broker Unix IPC socket-path preflight', () => {
  it('allocates a SHORT hashed b.sock path that fits the sockaddr_un budget (RED)', () => {
    expect(typeof getBrokerIpcSocketPath).toBe('function')
    const socketPath = getBrokerIpcSocketPath!(
      { runtimeRoot: '/Users/lherron/praesidium/var/run/hrc' },
      'claude-code-tmux',
      'runtime_0192aa3c-1d4e-7f00-9c11-abcdef012345'
    )
    // Shape: under a `bipc/<hash>/` dir, ending in `b.sock`.
    expect(socketPath).toContain('/bipc/')
    expect(socketPath.endsWith('/b.sock')).toBe(true)
    // Hard budget: the allocated path MUST fit the platform sockaddr_un limit.
    expect(socketPathByteLength(socketPath)).toBeLessThanOrEqual(socketPathByteBudget())
    // And it passes the ASP assertion without throwing.
    expect(() => assertSocketPathWithinBudget(socketPath)).not.toThrow()
  })

  it('preflight ACCEPTS a short path and REJECTS an over-budget path with a readable error (RED)', () => {
    expect(typeof preflightBrokerIpcSocketPath).toBe('function')

    const shortPath = '/tmp/bipc/abc123/b.sock'
    expect(() => preflightBrokerIpcSocketPath!(shortPath)).not.toThrow()

    // Synthesize a path guaranteed to exceed the platform budget.
    const overLong = `/tmp/${'x'.repeat(socketPathByteBudget() + 16)}/b.sock`
    expect(socketPathByteLength(overLong)).toBeGreaterThan(socketPathByteBudget())
    let threw: unknown
    try {
      preflightBrokerIpcSocketPath!(overLong)
    } catch (error) {
      threw = error
    }
    expect(threw).toBeInstanceOf(Error)
    expect(String((threw as Error)?.message)).toMatch(/socket path too long/i)
  })
})
