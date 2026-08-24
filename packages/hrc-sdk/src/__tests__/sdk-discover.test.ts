/**
 * RED/GREEN tests for hrc-sdk (T-00956 / T-00955)
 *
 * Tests the hrc-sdk typed Unix socket client surface:
 *   - discoverSocket() — finds socket via resolveControlSocketPath(), throws when missing
 *   - HrcClient — HTTP-over-Unix-socket constructor and request plumbing
 *   - Typed error parsing — non-2xx responses parsed into HrcDomainError
 *   - resolveSession() — POST /v1/sessions/resolve round-trip
 *   - listSessions() — GET /v1/sessions round-trip
 *   - getSession() — GET /v1/sessions/by-host/:id round-trip
 *   - watch() — GET /v1/events NDJSON parsing into AsyncIterable<HrcLifecycleEvent>
 *   - Export surface from src/index.ts
 *
 * Pass conditions for Curly (T-00955):
 *   1. discoverSocket() returns socket path when socket file exists
 *   2. discoverSocket() throws with clear error when socket file is missing
 *   3. HrcClient constructor accepts a socket path
 *   4. HrcClient methods throw HrcDomainError for non-2xx responses with typed code
 *   5. resolveSession() sends POST, returns ResolveSessionResponse
 *   6. listSessions() sends GET, returns HrcSessionRecord[]
 *   7. getSession() sends GET, returns HrcSessionRecord, throws 404 as HrcDomainError
 *   8. watch() returns AsyncIterable<HrcLifecycleEvent> from NDJSON stream
 *   9. watch({ fromSeq }) sends fromSeq query param
 *  10. All public types are exported from src/index.ts
 *
 * Test strategy:
 *   - Socket discovery tests use real filesystem (no mock)
 *   - Client round-trip tests spin up a real hrc-server on a temp socket
 *   - Error parsing tests use a minimal Bun.serve stub that returns known error shapes
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// RED GATE: These imports will fail until Curly implements the sdk module
import { discoverSocket } from '../index'

// ---------------------------------------------------------------------------
// 1. discoverSocket() — socket discovery
// ---------------------------------------------------------------------------
describe('discoverSocket', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-discover-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns the socket path when socket file exists', async () => {
    // Set up env to point to our tmp runtime dir
    const runtimeDir = join(tmpDir, 'runtime')
    await mkdir(runtimeDir, { recursive: true })
    const sockPath = join(runtimeDir, 'hrc.sock')
    // Create a placeholder socket file (just needs to exist for discovery)
    await writeFile(sockPath, '')

    const originalEnv = process.env['HRC_RUNTIME_DIR']
    process.env['HRC_RUNTIME_DIR'] = runtimeDir
    try {
      const discovered = discoverSocket()
      expect(discovered).toBe(sockPath)
    } finally {
      if (originalEnv !== undefined) {
        process.env['HRC_RUNTIME_DIR'] = originalEnv
      } else {
        process.env['HRC_RUNTIME_DIR'] = undefined
      }
    }
  })

  it('throws when socket file does not exist', () => {
    const originalEnv = process.env['HRC_RUNTIME_DIR']
    process.env['HRC_RUNTIME_DIR'] = join(tmpDir, 'nonexistent')
    try {
      expect(() => discoverSocket()).toThrow()
    } finally {
      if (originalEnv !== undefined) {
        process.env['HRC_RUNTIME_DIR'] = originalEnv
      } else {
        process.env['HRC_RUNTIME_DIR'] = undefined
      }
    }
  })
})
