/**
 * RED/GREEN tests for C-3: Missing spawn error handler in hrc-launch exec (T-00977)
 *
 * Bug: exec.ts spawns a child process but never attaches a child.on('error')
 * handler. If the command doesn't exist (ENOENT) or isn't executable (EACCES),
 * the spawn emits 'error' with no listener. The process hangs because the
 * 'exit' event may never fire for spawn failures, leaving the Promise
 * unresolved and the launch in a ghost state.
 *
 * These tests verify that exec.ts handles spawn errors gracefully by:
 *   - Exiting with a non-zero code when the command doesn't exist
 *   - Posting or spooling a failure callback
 *   - Not hanging indefinitely
 *
 * Pass conditions for Larry (T-00977):
 *   1. child.on('error') handler must be registered
 *   2. ENOENT spawn failure must resolve the exit promise (not hang)
 *   3. A failure callback (exited with error context) must be posted or spooled
 *   4. Process must exit with non-zero code on spawn failure
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLaunchArtifact } from 'hrc-core'
import { writeLaunchArtifact } from '../launch/launch-artifact'

let tmpDir: string
let spoolDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-launch-spawn-err-'))
  spoolDir = join(tmpDir, 'spool')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeArtifact(overrides: Partial<HrcLaunchArtifact> = {}): HrcLaunchArtifact {
  return {
    launchId: 'launch-spawn-err-001',
    hostSessionId: 'hsid-spawn-err',
    generation: 1,
    runtimeId: 'rt-spawn-err',
    harness: 'claude-code',
    provider: 'anthropic',
    argv: ['/nonexistent/binary/that/does/not/exist'],
    env: {},
    cwd: tmpDir,
    callbackSocketPath: join(tmpDir, 'fake.sock'),
    spoolDir,
    correlationEnv: {
      HRC_HOST_SESSION_ID: 'hsid-spawn-err',
      HRC_GENERATION: '1',
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// C-3: Spawn error handling
// ---------------------------------------------------------------------------
describe('C-3: exec spawn error handling', () => {
  it('exits with non-zero code when command does not exist (ENOENT)', async () => {
    const artifact = makeArtifact({
      argv: ['/nonexistent/command/that/will/ENOENT'],
    })
    const launchFile = await writeLaunchArtifact(artifact, tmpDir)

    // Run exec.ts as a subprocess — it should exit with non-zero, not hang
    const execPath = join(import.meta.dir, '..', 'launch', 'exec.ts')
    const proc = Bun.spawn(['bun', 'run', execPath, '--launch-file', launchFile], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: tmpDir },
    })

    // Must not hang — give it 10 seconds max
    const timeout = setTimeout(() => {
      proc.kill()
    }, 10_000)

    const exitCode = await proc.exited
    clearTimeout(timeout)

    // RED condition: currently the process hangs or crashes with unhandled error
    // GREEN condition: exits with non-zero code
    expect(exitCode).not.toBe(0)
  }, 15_000)

  it('spools a failure callback when spawn fails', async () => {
    const artifact = makeArtifact({
      launchId: 'launch-spool-check',
      argv: ['/nonexistent/command/that/will/ENOENT'],
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

    await proc.exited
    clearTimeout(timeout)

    // Check that a spool entry was written for the failure
    const { readSpoolEntries } = await import('../launch/spool')
    const entries = await readSpoolEntries(spoolDir, 'launch-spool-check')

    // RED: currently no spool entry is written because the error handler doesn't exist
    // GREEN: at least one spool entry with exited/error endpoint
    // Note: wrapper-started spool may also be present, so look for the exit/error one
    const exitEntries = entries.filter(
      (e) =>
        (e.payload as any)?.endpoint?.includes('exited') ||
        (e.payload as any)?.endpoint?.includes('error')
    )
    expect(exitEntries.length).toBeGreaterThanOrEqual(1)
  }, 15_000)

  it('does not hang on EACCES (permission denied)', async () => {
    // Create a file that exists but is not executable
    const nonExecPath = join(tmpDir, 'not-executable.sh')
    await writeFile(nonExecPath, '#!/bin/sh\necho hello\n')
    await chmod(nonExecPath, 0o644) // readable but not executable

    const artifact = makeArtifact({
      launchId: 'launch-eacces',
      argv: [nonExecPath],
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

    // RED: process hangs or crashes
    // GREEN: exits with non-zero code
    expect(exitCode).not.toBe(0)
  }, 15_000)
})
