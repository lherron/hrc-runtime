/**
 * RED/GREEN tests for C-4: Exit handler unhandled rejection in hrc-launch exec (T-00978)
 *
 * Bug: In exec.ts, the child 'exit' handler calls callbackOrSpool().then(resolve)
 * but has no .catch(). If callbackOrSpool() rejects (e.g. spool write fails
 * due to disk full, permissions, etc.), the promise rejection goes unhandled.
 * This can cause the process to hang (resolve never called) or crash with
 * an unhandled rejection.
 *
 * These tests verify that even when the callback/spool path fails during
 * exit handling, the process still exits cleanly with the child's exit code.
 *
 * Pass conditions for Larry (T-00978):
 *   1. callbackOrSpool failures in exit handler must be caught
 *   2. Process must still exit with the child's exit code even if callback fails
 *   3. The failure should be logged to stderr
 *   4. No unhandled promise rejection
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLaunchArtifact } from 'hrc-core'
import { writeLaunchArtifact } from '../launch/launch-artifact'

let tmpDir: string
const servers = new Set<Server>()

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-launch-exit-rej-'))
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
    launchId: 'launch-exit-rej-001',
    hostSessionId: 'hsid-exit-rej',
    generation: 1,
    runtimeId: 'rt-exit-rej',
    harness: 'claude-code',
    provider: 'anthropic',
    argv: ['/bin/sh', '-c', 'exit 42'],
    env: {},
    cwd: tmpDir,
    callbackSocketPath: join(tmpDir, 'fake.sock'),
    spoolDir: join(tmpDir, 'spool'),
    correlationEnv: {
      HRC_HOST_SESSION_ID: 'hsid-exit-rej',
      HRC_GENERATION: '1',
    },
    ...overrides,
  }
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

async function setupExitFailureCallbackServer(socketPath: string): Promise<string[]> {
  const requests: string[] = []
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
  return requests
}

// ---------------------------------------------------------------------------
// C-4: Exit handler rejection handling
// ---------------------------------------------------------------------------
describe('C-4: exec exit handler unhandled rejection', () => {
  it('exits with child exit code even when spool dir is not writable', async () => {
    const socketPath = join(tmpDir, 'callback.sock')
    const requests = await setupExitFailureCallbackServer(socketPath)
    const blockingFile = join(tmpDir, 'not-a-dir')
    await writeFile(blockingFile, 'I am a file, not a directory')

    const artifact = makeArtifact({
      launchId: 'launch-exit-rej-readonly',
      callbackSocketPath: socketPath,
      spoolDir: join(blockingFile, 'subdir'),
      argv: ['/bin/sh', '-c', 'sleep 0.05; exit 42'],
    })
    const launchFile = await writeLaunchArtifact(artifact, tmpDir)

    const execPath = join(import.meta.dir, '..', 'launch', 'exec.ts')
    const proc = Bun.spawn(['bun', 'run', execPath, '--launch-file', launchFile], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: tmpDir },
    })

    const timeout = setTimeout(() => {
      proc.kill()
    }, 10_000)

    const exitCode = await proc.exited
    clearTimeout(timeout)

    // RED: callbackOrSpool rejects in exit handler, promise goes unhandled,
    //      process may hang or crash with unhandled rejection instead of
    //      exiting with the child's code.
    // GREEN: process exits with child's exit code (42) regardless of
    //        callback/spool failure
    expect(exitCode).toBe(42)
    expect(requests).toEqual([
      `/v1/internal/launches/${artifact.launchId}/wrapper-started`,
      `/v1/internal/launches/${artifact.launchId}/child-started`,
    ])
  }, 15_000)

  it('does not produce unhandled promise rejection on spool failure', async () => {
    const socketPath = join(tmpDir, 'callback.sock')
    const requests = await setupExitFailureCallbackServer(socketPath)
    const blockingFile = join(tmpDir, 'not-a-dir')
    await writeFile(blockingFile, 'I am a file, not a directory')

    const artifact = makeArtifact({
      launchId: 'launch-exit-rej-nodir',
      callbackSocketPath: socketPath,
      spoolDir: join(blockingFile, 'subdir'), // will fail — parent is a file
      argv: ['/bin/sh', '-c', 'sleep 0.05; exit 0'],
    })
    const launchFile = await writeLaunchArtifact(artifact, tmpDir)

    const execPath = join(import.meta.dir, '..', 'launch', 'exec.ts')
    const proc = Bun.spawn(['bun', 'run', execPath, '--launch-file', launchFile], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: tmpDir },
    })

    const timeout = setTimeout(() => {
      proc.kill()
    }, 10_000)

    const exitCode = await proc.exited
    clearTimeout(timeout)

    const stderr = await new Response(proc.stderr).text()

    // RED: unhandled rejection crashes or hangs the process
    // GREEN: process exits cleanly (exit code 0 from child) and logs the
    //        spool failure to stderr
    expect(exitCode).toBe(0)
    // Should NOT contain "unhandled" or crash with rejection
    expect(stderr).not.toContain('UnhandledPromiseRejection')
    expect(stderr).toContain('failed to post/spool exit callback')
    expect(requests).toEqual([
      `/v1/internal/launches/${artifact.launchId}/wrapper-started`,
      `/v1/internal/launches/${artifact.launchId}/child-started`,
    ])
  }, 15_000)

  it('preserves child signal-based exit when callback fails', async () => {
    const socketPath = join(tmpDir, 'callback.sock')
    await setupExitFailureCallbackServer(socketPath)
    const blockingFile = join(tmpDir, 'not-a-dir')
    await writeFile(blockingFile, 'I am a file, not a directory')

    const artifact = makeArtifact({
      launchId: 'launch-exit-rej-signal',
      callbackSocketPath: socketPath,
      spoolDir: join(blockingFile, 'subdir'),
      // Child kills itself with SIGTERM
      argv: ['/bin/sh', '-c', 'sleep 0.05; kill -TERM $$'],
    })
    const launchFile = await writeLaunchArtifact(artifact, tmpDir)

    const execPath = join(import.meta.dir, '..', 'launch', 'exec.ts')
    const proc = Bun.spawn(['bun', 'run', execPath, '--launch-file', launchFile], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: tmpDir },
    })

    const timeout = setTimeout(() => {
      proc.kill()
    }, 10_000)

    const exitCode = await proc.exited
    clearTimeout(timeout)

    // RED: process hangs due to unhandled rejection in exit handler
    // GREEN: process exits with non-zero code (signal-based termination)
    expect(exitCode).not.toBe(0)
  }, 15_000)
})
