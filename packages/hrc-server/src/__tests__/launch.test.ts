/**
 * RED/GREEN tests for hrc-launch (T-00953 / T-00952)
 *
 * Tests the public surface of hrc-launch:
 *   - Spool write/read ordering (multiple callbacks, monotonic seq)
 *   - Callback failure triggers spool fallback
 *
 * T-08566 stage 1 retired the launch artifact and hook envelope helpers; their
 * round-trip tests went with them. Spool and callback client stay (Desktop hook).
 *
 * Pass conditions for Curly (T-00952):
 *   2. spoolCallback writes monotonically sequenced files, readSpoolEntries returns them in order
 *   4. postCallback returns false on connection failure (no throw)
 *   5. Failed callback triggers spool write when integrated
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These imports are the RED gates — they will fail until Curly implements the modules
import { readSpoolEntries, spoolCallback } from '../launch/spool'

import { postCallback } from '../launch/callback-client'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-launch-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
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
    const readPromises = Array.from({ length: 5 }, () =>
      readSpoolEntries(spoolDir, launchId).catch(() => [])
    )

    const [writePaths] = await Promise.all([Promise.all(writePromises), Promise.all(readPromises)])

    // All 15 writes must have succeeded with unique paths
    expect(new Set(writePaths).size).toBe(15)

    // Final read must show all 15
    const finalEntries = await readSpoolEntries(spoolDir, launchId)
    expect(finalEntries.length).toBe(15)
    expect(new Set(finalEntries.map((e) => e.seq)).size).toBe(15)
  })

  // --- Spool write to parent that is a file (not a directory) ---
  it('throws when spool directory parent is a regular file', async () => {
    const blockingFile = join(tmpDir, 'blocker')
    await writeFile(blockingFile, 'not a directory')

    await expect(
      spoolCallback(join(blockingFile, 'subdir'), 'launch-blocked', { step: 'test' })
    ).rejects.toThrow()
  })
})
