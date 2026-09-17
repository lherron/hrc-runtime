/**
 * T-08564 Phase A red: the SDK owns one async daemon hop for declaration-backed
 * runtime intent resolution. These tests deliberately reach the additive method
 * through a runtime type so the pre-implementation suite collects and fails on
 * the missing behavior, not on a TypeScript import/member error.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcDomainError } from 'hrc-core'

import { HrcClient } from '../index.js'

type ResolveRuntimeIntent = (
  request: Record<string, unknown>,
  options?: { timeoutMs?: number }
) => Promise<unknown>

const request = {
  agentId: 'smokey',
  agentRoot: '/tmp/t08564-agent',
  projectRoot: '/tmp/t08564-project',
  cwd: '/tmp/t08564-project',
  runMode: 'task',
  interactive: false,
  preferredMode: 'nonInteractive',
  allowInteractiveSurfaceReuse: false,
  provision: { model: 'x' },
}

function resolveMethod(client: HrcClient): ResolveRuntimeIntent {
  const candidate = (client as unknown as { resolveRuntimeIntent?: unknown }).resolveRuntimeIntent
  expect(typeof candidate).toBe('function')
  return (input, options) =>
    (candidate as ResolveRuntimeIntent).call(client, input, options) as Promise<unknown>
}

describe('HrcClient.resolveRuntimeIntent (T-08564 Phase A red)', () => {
  let tmpDir: string
  let socketPath: string
  let server: ReturnType<typeof Bun.serve> | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-t08564-'))
    socketPath = join(tmpDir, 'hrc.sock')
  })

  afterEach(async () => {
    server?.stop(true)
    server = undefined
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('POSTs the request and passes through the 200 intent plus declaration body', async () => {
    let observedPath = ''
    let observedBody: unknown
    const expected = {
      intent: {
        placement: {
          agentRoot: request.agentRoot,
          projectRoot: request.projectRoot,
          cwd: request.cwd,
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
        },
        harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
        execution: { preferredMode: 'nonInteractive' },
        provision: { model: 'x' },
      },
      declaration: {
        release: { releaseId: 'asp-t08564', sourceCommit: 'a'.repeat(40) },
        agentSources: { agentsRoot: '/tmp/agents', provenance: 'caller-agent-root' },
        source: {
          agentProfile: 'valid',
          projectTargets: 'valid',
          selectedTarget: 'valid',
          priming: 'absent',
        },
        warnings: [],
      },
    }
    server = Bun.serve({
      unix: socketPath,
      async fetch(httpRequest) {
        observedPath = new URL(httpRequest.url).pathname
        observedBody = await httpRequest.json()
        return Response.json(expected)
      },
    })

    const result = await resolveMethod(new HrcClient(socketPath))(request)

    expect(observedPath).toBe('/v1/declarations/resolve')
    expect(observedBody).toEqual(request)
    expect(result).toEqual(expected)
  })

  test('projects a route-less older daemon as unsupported_capability', async () => {
    server = Bun.serve({
      unix: socketPath,
      fetch() {
        return Response.json(
          { error: { code: 'unknown_route', message: 'not found', detail: {} } },
          { status: 404 }
        )
      },
    })
    const resolve = resolveMethod(new HrcClient(socketPath))

    try {
      await resolve(request)
      expect.unreachable('resolveRuntimeIntent should reject a route-less daemon')
    } catch (error) {
      expect(error).toBeInstanceOf(HrcDomainError)
      expect((error as HrcDomainError).code).toBe('unsupported_capability')
      expect((error as HrcDomainError).detail).toMatchObject({
        capability: 'declarations.resolve',
      })
    }
  })

  test('projects a missing daemon socket as runtime_unavailable', async () => {
    const resolve = resolveMethod(new HrcClient(socketPath))
    try {
      await resolve(request)
      expect.unreachable('resolveRuntimeIntent should reject an absent HRC socket')
    } catch (error) {
      expect(error).toBeInstanceOf(HrcDomainError)
      expect((error as HrcDomainError).code).toBe('runtime_unavailable')
      expect((error as HrcDomainError).detail).toMatchObject({
        code: 'hrc_daemon_unreachable',
        socketPath,
      })
    }
  })

  test('honors timeoutMs with the platform abort/timeout error unchanged', async () => {
    server = Bun.serve({
      unix: socketPath,
      async fetch() {
        await Bun.sleep(2_000)
        return Response.json({ intent: {}, declaration: {} })
      },
    })
    const resolve = resolveMethod(new HrcClient(socketPath))
    const startedAt = performance.now()
    let caught: unknown

    try {
      await resolve(request, { timeoutMs: 100 })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(['AbortError', 'TimeoutError']).toContain((caught as Error).name)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })

  test('preserves typed aspd_unavailable detail from a 503 daemon response', async () => {
    server = Bun.serve({
      unix: socketPath,
      fetch() {
        return Response.json(
          {
            error: {
              code: 'runtime_unavailable',
              message: 'declaration evidence unavailable',
              detail: { code: 'aspd_unavailable', route: 'aspd' },
            },
          },
          { status: 503 }
        )
      },
    })
    const resolve = resolveMethod(new HrcClient(socketPath))

    try {
      await resolve(request)
      expect.unreachable('resolveRuntimeIntent should reject an aspd outage')
    } catch (error) {
      expect(error).toBeInstanceOf(HrcDomainError)
      expect((error as HrcDomainError).code).toBe('runtime_unavailable')
      expect((error as HrcDomainError).detail).toEqual({
        code: 'aspd_unavailable',
        route: 'aspd',
      })
    }
  })
})
