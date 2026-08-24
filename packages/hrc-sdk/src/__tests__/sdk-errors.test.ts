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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'

// RED GATE: These imports will fail until Curly implements the sdk module
import { HrcClient } from '../index'
import type { ResolveSessionRequest } from '../index'

// ---------------------------------------------------------------------------
// 1. discoverSocket() — socket discovery
// ---------------------------------------------------------------------------
describe('typed error parsing', () => {
  let tmpDir: string
  let stubSocketPath: string
  let stubServer: ReturnType<typeof Bun.serve> | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-error-'))
    stubSocketPath = join(tmpDir, 'stub.sock')
  })

  afterEach(async () => {
    if (stubServer) {
      stubServer.stop(true)
      stubServer = undefined
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('parses 404 response into HrcDomainError with correct code', async () => {
    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        return Response.json(
          {
            error: {
              code: 'unknown_host_session',
              message: 'Session not found',
              detail: {},
            },
          },
          { status: 404 }
        )
      },
    })

    const client = new HrcClient(stubSocketPath)
    try {
      await client.getSession('nonexistent')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as InstanceType<typeof HrcDomainError>
      expect(domainErr.code).toBe(HrcErrorCode.UNKNOWN_HOST_SESSION)
      expect(domainErr.status).toBe(404)
    }
  })

  it('parses 400 response into HrcDomainError with correct code', async () => {
    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        return Response.json(
          {
            error: {
              code: 'malformed_request',
              message: 'Missing required field: sessionRef',
              detail: { field: 'sessionRef' },
            },
          },
          { status: 400 }
        )
      },
    })

    const client = new HrcClient(stubSocketPath)
    try {
      await client.resolveSession({} as ResolveSessionRequest)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as InstanceType<typeof HrcDomainError>
      expect(domainErr.code).toBe(HrcErrorCode.MALFORMED_REQUEST)
      expect(domainErr.status).toBe(400)
      expect(domainErr.detail).toEqual({ field: 'sessionRef' })
    }
  })

  it('parses 409 response into HrcDomainError', async () => {
    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        return Response.json(
          {
            error: {
              code: 'stale_context',
              message: 'Generation mismatch',
              detail: { expected: 1, actual: 2 },
            },
          },
          { status: 409 }
        )
      },
    })

    const client = new HrcClient(stubSocketPath)
    try {
      await client.resolveSession({
        sessionRef: 'project:test/lane:default',
      } as ResolveSessionRequest)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as InstanceType<typeof HrcDomainError>
      expect(domainErr.code).toBe(HrcErrorCode.STALE_CONTEXT)
    }
  })

  it('includes a typed internal error code and response cause in the thrown message', async () => {
    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        return Response.json(
          {
            error: {
              code: 'internal_error',
              message: 'internal server error',
              detail: {
                cause: 'forced handler failure T-05639',
                requestId: 'req-t05639-sdk',
              },
            },
          },
          { status: 500 }
        )
      },
    })

    const client = new HrcClient(stubSocketPath)
    try {
      await client.listSessions()
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      expect((err as HrcDomainError).code).toBe(HrcErrorCode.INTERNAL_ERROR)
      expect((err as Error).message).toContain(HrcErrorCode.INTERNAL_ERROR)
      expect((err as Error).message).toContain('forced handler failure T-05639')
      expect((err as Error).message).toContain('req-t05639-sdk')
    }
  })
})

// ---------------------------------------------------------------------------
// 3. NDJSON watch parsing (using a stub server)
// ---------------------------------------------------------------------------
