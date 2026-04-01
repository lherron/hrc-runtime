import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { HrcLaunchArtifact } from 'hrc-core'

import { writeLaunchArtifact } from '../launch/launch-artifact'
import { readSpoolEntries } from '../launch/spool'

const EXEC_PATH = fileURLToPath(new URL('../launch/exec.ts', import.meta.url))

let tmpDir: string
const servers = new Set<Server>()

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-launch-exec-test-'))
})

afterEach(async () => {
  await Promise.all(
    Array.from(servers).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
  await rm(tmpDir, { recursive: true, force: true })
})

function makeArtifact(overrides: Partial<HrcLaunchArtifact> = {}): HrcLaunchArtifact {
  return {
    launchId: 'launch-exec-test-001',
    hostSessionId: 'hsid-exec-test-001',
    generation: 1,
    runtimeId: 'rt-exec-test-001',
    harness: 'claude-code',
    provider: 'anthropic',
    argv: [process.execPath, '-e', 'process.exit(0)'],
    env: { HOME: tmpDir, HRC_LAUNCH_ID: 'launch-exec-test-001' },
    cwd: tmpDir,
    callbackSocketPath: join(tmpDir, 'callbacks.sock'),
    spoolDir: join(tmpDir, 'spool'),
    correlationEnv: {
      HRC_HOST_SESSION_ID: 'hsid-exec-test-001',
      HRC_GENERATION: '1',
    },
    ...overrides,
  }
}

async function runExec(
  artifact: HrcLaunchArtifact,
  timeoutMs = 2_000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const launchFile = await writeLaunchArtifact(artifact, join(tmpDir, 'artifacts'))
  const proc = Bun.spawn([process.execPath, EXEC_PATH, '--launch-file', launchFile], {
    cwd: tmpDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const exitCode = await Promise.race<number>([
    proc.exited,
    new Promise<number>((_, reject) => {
      setTimeout(
        () => reject(new Error(`hrc-launch exec timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    }),
  ])

  const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)])
  return { exitCode, stdout, stderr }
}

async function readStream(stream: ReadableStream | null): Promise<string> {
  if (!stream) {
    return ''
  }

  return await new Response(stream).text()
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  servers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

describe('hrc-launch exec crash paths', () => {
  it('spools an exited callback when spawn emits an error', async () => {
    const launchId = 'launch-spawn-error'
    const spoolDir = join(tmpDir, 'spool')
    const result = await runExec(
      makeArtifact({
        launchId,
        callbackSocketPath: join(tmpDir, 'missing.sock'),
        spoolDir,
        argv: [join(tmpDir, 'does-not-exist')],
      })
    )

    expect(result.exitCode).toBe(1)

    const entries = await readSpoolEntries(spoolDir, launchId)
    const endpoints = entries.map((entry) => (entry.payload as { endpoint?: string }).endpoint)

    expect(endpoints).toContain(`/v1/internal/launches/${launchId}/wrapper-started`)
    expect(endpoints).toContain(`/v1/internal/launches/${launchId}/exited`)
    expect(endpoints).not.toContain(`/v1/internal/launches/${launchId}/child-started`)

    const exitedEntry = entries.find(
      (entry) =>
        (entry.payload as { endpoint?: string }).endpoint ===
        `/v1/internal/launches/${launchId}/exited`
    )
    expect((exitedEntry?.payload as { payload?: { exitCode?: number } }).payload?.exitCode).toBe(1)
  })

  it('logs exit callback failures and still exits with the child code', async () => {
    const launchId = 'launch-exit-callback-failure'
    const socketPath = join(tmpDir, 'callbacks.sock')
    const spoolDir = join(tmpDir, 'blocked-spool')
    const requests: string[] = []

    await writeFile(spoolDir, 'not-a-directory', 'utf-8')

    const server = createServer((req, res) => {
      requests.push(req.url ?? '')
      res.statusCode = 204
      res.end(() => {
        if (requests.length === 2) {
          server.close()
        }
      })
    })
    await listenOnSocket(server, socketPath)

    const result = await runExec(
      makeArtifact({
        launchId,
        callbackSocketPath: socketPath,
        spoolDir,
        argv: [process.execPath, '-e', 'setTimeout(() => process.exit(7), 50)'],
      })
    )

    expect(result.exitCode).toBe(7)
    expect(result.stderr).toContain('failed')
    expect(requests).toEqual([
      `/v1/internal/launches/${launchId}/wrapper-started`,
      `/v1/internal/launches/${launchId}/child-started`,
    ])
  })
})
