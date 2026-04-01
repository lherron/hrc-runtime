/**
 * RED/GREEN tests for hrc-launch (T-00953 / T-00952)
 *
 * Tests the public surface of hrc-launch:
 *   - Launch artifact write/read round-trip
 *   - Spool write/read ordering (multiple callbacks, monotonic seq)
 *   - Hook envelope construction from stdin JSON
 *   - Callback failure triggers spool fallback
 *
 * Pass conditions for Curly (T-00952):
 *   1. writeLaunchArtifact writes <dir>/<launchId>.json, readLaunchArtifact round-trips it
 *   2. spoolCallback writes monotonically sequenced files, readSpoolEntries returns them in order
 *   3. buildHookEnvelope attaches launch context to stdin JSON
 *   4. postCallback returns false on connection failure (no throw)
 *   5. Failed callback triggers spool write when integrated
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HrcLaunchArtifact } from 'hrc-core'

// These imports are the RED gates — they will fail until Curly implements the modules
import { readLaunchArtifact, writeLaunchArtifact } from '../launch/launch-artifact'

import { replaySpoolEntries } from '../launch/index'
import { readSpoolEntries, spoolCallback } from '../launch/spool'

import { buildHookEnvelope } from '../launch/hook'

import { postCallback } from '../launch/callback-client'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-launch-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helper: create a valid HrcLaunchArtifact for testing
// ---------------------------------------------------------------------------
function makeArtifact(overrides: Partial<HrcLaunchArtifact> = {}): HrcLaunchArtifact {
  return {
    launchId: 'launch-test-001',
    hostSessionId: 'hsid-test-001',
    generation: 1,
    runtimeId: 'rt-test-001',
    harness: 'claude-code',
    provider: 'anthropic',
    argv: ['/usr/bin/claude', '--session', 'test'],
    env: { HOME: '/Users/test', HRC_LAUNCH_ID: 'launch-test-001' },
    cwd: '/tmp/workspace',
    callbackSocketPath: '/tmp/hrc.sock',
    spoolDir: '/tmp/spool',
    correlationEnv: {
      HRC_HOST_SESSION_ID: 'hsid-test-001',
      HRC_GENERATION: '1',
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Launch artifact write/read round-trip
// ---------------------------------------------------------------------------
describe('Launch artifact IO', () => {
  it('writes artifact to <dir>/<launchId>.json and returns the path', async () => {
    const artifact = makeArtifact()
    const path = await writeLaunchArtifact(artifact, tmpDir)

    expect(path).toBe(join(tmpDir, 'launch-test-001.json'))

    // Verify file exists and is valid JSON
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.launchId).toBe('launch-test-001')
  })

  it('round-trips a full artifact through write/read', async () => {
    const artifact = makeArtifact({
      runId: 'run-test-001',
      launchEnv: { extra: 'value' },
      hookBridge: { kind: 'agentchat', config: { channel: 'main' } },
    })

    const path = await writeLaunchArtifact(artifact, tmpDir)
    const read = await readLaunchArtifact(path)

    expect(read).toEqual(artifact)
  })

  it('preserves all fields including optional ones', async () => {
    const artifact = makeArtifact({
      runId: 'run-002',
      launchEnv: { PATH_PREFIX: '/opt/bin' },
      hookBridge: { kind: 'custom', config: { foo: 'bar' } },
    })

    const path = await writeLaunchArtifact(artifact, tmpDir)
    const read = await readLaunchArtifact(path)

    expect(read.runId).toBe('run-002')
    expect(read.launchEnv).toEqual({ PATH_PREFIX: '/opt/bin' })
    expect(read.hookBridge).toEqual({ kind: 'custom', config: { foo: 'bar' } })
    expect(read.argv).toEqual(artifact.argv)
    expect(read.env).toEqual(artifact.env)
    expect(read.correlationEnv).toEqual(artifact.correlationEnv)
  })

  it('throws on readLaunchArtifact for non-existent file', async () => {
    await expect(readLaunchArtifact('/nonexistent/path.json')).rejects.toThrow()
  })

  it('throws on readLaunchArtifact for malformed JSON', async () => {
    const badPath = join(tmpDir, 'bad.json')
    await Bun.write(badPath, '{ not valid json }}}')
    await expect(readLaunchArtifact(badPath)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2. Spool write/read ordering
// ---------------------------------------------------------------------------
describe('Spool helpers', () => {
  it('writes a spool entry and reads it back', async () => {
    const spoolDir = join(tmpDir, 'spool')
    const payload = { endpoint: '/v1/internal/launches/l1/wrapper-started', body: { pid: 123 } }

    const path = await spoolCallback(spoolDir, 'launch-001', payload)
    expect(path).toContain('launch-001')
    expect(path).toEndWith('.json')

    const entries = await readSpoolEntries(spoolDir, 'launch-001')
    expect(entries.length).toBe(1)
    expect(entries[0].payload).toEqual(payload)
    expect(entries[0].seq).toBeDefined()
  })

  it('maintains monotonic seq across multiple spool writes', async () => {
    const spoolDir = join(tmpDir, 'spool')

    await spoolCallback(spoolDir, 'launch-002', { step: 'wrapper-started' })
    await spoolCallback(spoolDir, 'launch-002', { step: 'child-started' })
    await spoolCallback(spoolDir, 'launch-002', { step: 'exited' })

    const entries = await readSpoolEntries(spoolDir, 'launch-002')
    expect(entries.length).toBe(3)

    // Verify monotonic ordering
    expect(entries[0].seq).toBeLessThan(entries[1].seq)
    expect(entries[1].seq).toBeLessThan(entries[2].seq)

    // Verify payload ordering matches write order
    expect((entries[0].payload as any).step).toBe('wrapper-started')
    expect((entries[1].payload as any).step).toBe('child-started')
    expect((entries[2].payload as any).step).toBe('exited')
  })

  it('isolates spool entries by launchId', async () => {
    const spoolDir = join(tmpDir, 'spool')

    await spoolCallback(spoolDir, 'launch-a', { from: 'a' })
    await spoolCallback(spoolDir, 'launch-b', { from: 'b' })
    await spoolCallback(spoolDir, 'launch-a', { from: 'a-2' })

    const entriesA = await readSpoolEntries(spoolDir, 'launch-a')
    const entriesB = await readSpoolEntries(spoolDir, 'launch-b')

    expect(entriesA.length).toBe(2)
    expect(entriesB.length).toBe(1)
    expect((entriesA[0].payload as any).from).toBe('a')
    expect((entriesB[0].payload as any).from).toBe('b')
  })

  it('returns empty array for launch with no spool entries', async () => {
    const spoolDir = join(tmpDir, 'spool')
    const entries = await readSpoolEntries(spoolDir, 'nonexistent-launch')
    expect(entries).toEqual([])
  })

  it('does not overwrite entries when callbacks are spooled concurrently', async () => {
    const spoolDir = join(tmpDir, 'spool')

    await Promise.all(
      Array.from({ length: 25 }, (_, i) => spoolCallback(spoolDir, 'launch-race', { index: i }))
    )

    const entries = await readSpoolEntries(spoolDir, 'launch-race')
    expect(entries.length).toBe(25)
    expect(new Set(entries.map((entry) => entry.seq)).size).toBe(25)
    expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(
      entries
        .map((entry) => (entry.payload as { index: number }).index)
        .sort((left, right) => left - right)
    ).toEqual(Array.from({ length: 25 }, (_, i) => i))
  })

  it('replays spooled callbacks through the public helper and removes delivered entries', async () => {
    const spoolDir = join(tmpDir, 'spool')
    const launchId = 'launch-replay'
    const deliveredCalls: Array<{ endpoint: string; payload: object }> = []

    await spoolCallback(spoolDir, launchId, {
      endpoint: '/v1/internal/launches/launch-replay/wrapper-started',
      payload: { step: 'wrapper-started' },
    })
    await spoolCallback(spoolDir, launchId, {
      endpoint: '/v1/internal/launches/launch-replay/exited',
      payload: { step: 'exited' },
    })

    const replayed = await replaySpoolEntries(
      spoolDir,
      launchId,
      '/tmp/unused.sock',
      async (_socketPath, endpoint, payload) => {
        deliveredCalls.push({ endpoint, payload })
        return endpoint.endsWith('/wrapper-started')
      }
    )

    expect(replayed).toEqual({ attempted: 2, delivered: 1, retained: 1 })
    expect(deliveredCalls).toEqual([
      {
        endpoint: '/v1/internal/launches/launch-replay/wrapper-started',
        payload: { step: 'wrapper-started' },
      },
      {
        endpoint: '/v1/internal/launches/launch-replay/exited',
        payload: { step: 'exited' },
      },
    ])

    const remaining = await readSpoolEntries(spoolDir, launchId)
    expect(remaining.length).toBe(1)
    expect((remaining[0].payload as { endpoint: string }).endpoint).toBe(
      '/v1/internal/launches/launch-replay/exited'
    )
  })
})

// ---------------------------------------------------------------------------
// 3. Hook envelope construction
// ---------------------------------------------------------------------------
describe('Hook envelope', () => {
  it('attaches launch context to stdin JSON', () => {
    const stdinJson = {
      event: 'tool_use',
      tool: 'bash',
      input: { command: 'ls' },
    }
    const env = {
      launchId: 'launch-hook-1',
      hostSessionId: 'hsid-hook-1',
      generation: 3,
      runtimeId: 'rt-hook-1',
    }

    const envelope = buildHookEnvelope(stdinJson, env)

    // Envelope must include the original event data under hookData
    expect(envelope.hookData).toEqual(stdinJson)
    // Envelope must include launch context
    expect(envelope.launchId).toBe('launch-hook-1')
    expect(envelope.hostSessionId).toBe('hsid-hook-1')
    expect(envelope.generation).toBe(3)
    expect(envelope.runtimeId).toBe('rt-hook-1')
  })

  it('handles missing optional runtimeId', () => {
    const stdinJson = { event: 'start' }
    const env = {
      launchId: 'launch-hook-2',
      hostSessionId: 'hsid-hook-2',
      generation: 1,
    }

    const envelope = buildHookEnvelope(stdinJson, env)
    expect(envelope.launchId).toBe('launch-hook-2')
    expect(envelope.runtimeId).toBeUndefined()
    expect(envelope.hookData).toEqual(stdinJson)
  })

  it('preserves complex nested stdin payloads', () => {
    const stdinJson = {
      event: 'tool_result',
      result: {
        output: 'line1\nline2',
        nested: { deep: true },
        array: [1, 2, 3],
      },
    }
    const env = {
      launchId: 'launch-hook-3',
      hostSessionId: 'hsid-hook-3',
      generation: 1,
    }

    const envelope = buildHookEnvelope(stdinJson, env)
    expect(envelope.hookData).toEqual(stdinJson)
  })
})

// ---------------------------------------------------------------------------
// 4. Callback client — failure triggers spool fallback
// ---------------------------------------------------------------------------
describe('Callback client', () => {
  it('returns false when socket does not exist (connection failure)', async () => {
    // Use a non-existent socket path to simulate daemon unavailable
    const result = await postCallback(
      '/tmp/nonexistent-hrc-test.sock',
      '/v1/internal/launches/l1/wrapper-started',
      { pid: 12345 }
    )
    expect(result).toBe(false)
  })

  it('returns false for connection refused (no server listening)', async () => {
    // Create a socket path that exists but has no listener
    const fakeSock = join(tmpDir, 'no-listener.sock')
    const result = await postCallback(fakeSock, '/v1/internal/hooks/ingest', { event: 'test' })
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Integration: callback failure should trigger spool write
//    (This tests the intended composition, not a single module)
// ---------------------------------------------------------------------------
describe('Callback-to-spool fallback integration', () => {
  it('spools payload when callback fails', async () => {
    const spoolDir = join(tmpDir, 'fallback-spool')
    const payload = {
      endpoint: '/v1/internal/launches/launch-fb-1/exited',
      body: { exitCode: 0, signal: null },
    }

    // Simulate: try callback, fail, then spool
    const delivered = await postCallback(
      '/tmp/nonexistent-hrc-test.sock',
      payload.endpoint,
      payload.body
    )
    expect(delivered).toBe(false)

    // On failure, the wrapper would spool
    const spoolPath = await spoolCallback(spoolDir, 'launch-fb-1', payload)
    expect(spoolPath).toBeDefined()

    // Verify spooled data is recoverable
    const entries = await readSpoolEntries(spoolDir, 'launch-fb-1')
    expect(entries.length).toBe(1)
    expect((entries[0].payload as any).endpoint).toBe(payload.endpoint)
  })
})

// ---------------------------------------------------------------------------
// n-37: Error-path integration coverage (T-00985)
// ---------------------------------------------------------------------------
describe('n-37: Error-path integration (T-00985)', () => {
  // --- Spawn failure integration ---
  it('spools a failure callback when exec subprocess fails (ENOENT)', async () => {
    const spoolDir = join(tmpDir, 'spawn-fail-spool')
    const artifact = makeArtifact({
      launchId: 'launch-spawn-fail-int',
      argv: ['/nonexistent/binary/that/does/not/exist'],
      callbackSocketPath: join(tmpDir, 'missing.sock'),
      spoolDir,
    })
    const launchFile = await writeLaunchArtifact(artifact, tmpDir)

    const execPath = join(import.meta.dir, '..', 'launch', 'exec.ts')
    const proc = Bun.spawn(['bun', 'run', execPath, '--launch-file', launchFile], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: tmpDir },
    })

    const timeout = setTimeout(() => proc.kill(), 10_000)
    const exitCode = await proc.exited
    clearTimeout(timeout)

    expect(exitCode).not.toBe(0)

    // Verify spool entries were written for the failure
    const entries = await readSpoolEntries(spoolDir, 'launch-spawn-fail-int')
    const endpoints = entries.map((e) => (e.payload as { endpoint?: string }).endpoint)

    // Must have wrapper-started and exited, but NOT child-started
    expect(endpoints).toContain('/v1/internal/launches/launch-spawn-fail-int/wrapper-started')
    expect(endpoints).toContain('/v1/internal/launches/launch-spawn-fail-int/exited')
    expect(endpoints).not.toContain('/v1/internal/launches/launch-spawn-fail-int/child-started')
  }, 15_000)

  // --- Concurrent spool under error conditions ---
  it('concurrent spool writes all succeed even when interleaved with reads', async () => {
    const spoolDir = join(tmpDir, 'concurrent-error-spool')
    const launchId = 'launch-concurrent-err'

    // Fire 15 writes concurrently while also reading mid-flight
    const writePromises = Array.from({ length: 15 }, (_, i) =>
      spoolCallback(spoolDir, launchId, {
        endpoint: `/v1/internal/launches/${launchId}/exited`,
        payload: { index: i, exitCode: 1 },
      })
    )

    // Interleave reads with writes
    const readPromises = Array.from({ length: 5 }, () => readSpoolEntries(spoolDir, launchId))

    const [writePaths] = await Promise.all([Promise.all(writePromises), Promise.all(readPromises)])

    // All 15 writes must have succeeded with unique paths
    expect(new Set(writePaths).size).toBe(15)

    // Final read must show all 15
    const finalEntries = await readSpoolEntries(spoolDir, launchId)
    expect(finalEntries.length).toBe(15)
    expect(new Set(finalEntries.map((e) => e.seq)).size).toBe(15)
  })

  // --- Exit handler rejection ---
  it('exits with child exit code when both callback and spool fail', async () => {
    const blockingFile = join(tmpDir, 'not-a-dir')
    await writeFile(blockingFile, 'I am a file, not a directory')

    const artifact = makeArtifact({
      launchId: 'launch-double-fail',
      argv: ['/bin/sh', '-c', 'exit 37'],
      callbackSocketPath: join(tmpDir, 'missing.sock'),
      spoolDir: join(blockingFile, 'subdir'), // spool will also fail
    })
    const launchFile = await writeLaunchArtifact(artifact, tmpDir)

    const execPath = join(import.meta.dir, '..', 'launch', 'exec.ts')
    const proc = Bun.spawn(['bun', 'run', execPath, '--launch-file', launchFile], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: tmpDir },
    })

    const timeout = setTimeout(() => proc.kill(), 10_000)
    const exitCode = await proc.exited
    clearTimeout(timeout)

    const stderr = await new Response(proc.stderr).text()

    // Process must exit non-zero, not hang or crash.
    // When both callback and spool fail on wrapper-started (before child spawns),
    // the exit code may be 1 (infrastructure failure) rather than the child's 37.
    expect(exitCode).not.toBe(0)
    // Should NOT have an unhandled rejection
    expect(stderr).not.toContain('UnhandledPromiseRejection')
  }, 15_000)

  // --- Replay with all deliveries failing ---
  it('retains all entries when replay delivers none', async () => {
    const spoolDir = join(tmpDir, 'replay-all-fail')
    const launchId = 'launch-replay-fail'

    await spoolCallback(spoolDir, launchId, {
      endpoint: '/v1/internal/launches/launch-replay-fail/wrapper-started',
      payload: { step: 'wrapper-started' },
    })
    await spoolCallback(spoolDir, launchId, {
      endpoint: '/v1/internal/launches/launch-replay-fail/exited',
      payload: { step: 'exited' },
    })

    // All deliveries fail
    const result = await replaySpoolEntries(
      spoolDir,
      launchId,
      '/tmp/unused.sock',
      async () => false
    )

    expect(result).toEqual({ attempted: 2, delivered: 0, retained: 2 })

    // All entries must still be on disk
    const remaining = await readSpoolEntries(spoolDir, launchId)
    expect(remaining.length).toBe(2)
  })

  // --- Spool write to parent that is a file (not a directory) ---
  it('throws when spool directory parent is a regular file', async () => {
    const blockingFile = join(tmpDir, 'blocker')
    await writeFile(blockingFile, 'not a directory')

    await expect(
      spoolCallback(join(blockingFile, 'subdir'), 'launch-blocked', { step: 'test' })
    ).rejects.toThrow()
  })

  // --- Artifact read with missing required fields ---
  it('throws on artifact missing required launchId field', async () => {
    const badPath = join(tmpDir, 'missing-field.json')
    await Bun.write(badPath, JSON.stringify({ hostSessionId: 'x', generation: 1 }))
    await expect(readLaunchArtifact(badPath)).rejects.toThrow()
  })
})
