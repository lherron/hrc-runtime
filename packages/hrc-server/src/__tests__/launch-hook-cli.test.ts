import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK_CLI_PATH = fileURLToPath(new URL('../launch/hook-cli.ts', import.meta.url))

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-hook-cli-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('hook cli', () => {
  it('fails fast when HRC_GENERATION is not a valid integer', async () => {
    const spoolDir = join(tmpDir, 'spool')
    const proc = Bun.spawn([process.execPath, HOOK_CLI_PATH], {
      cwd: tmpDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        HOME: tmpDir,
        HRC_LAUNCH_ID: 'launch-invalid-generation',
        HRC_HOST_SESSION_ID: 'hsid-invalid-generation',
        HRC_GENERATION: 'not-a-number',
        HRC_CALLBACK_SOCKET: join(tmpDir, 'callbacks.sock'),
        HRC_SPOOL_DIR: spoolDir,
      },
    })

    proc.stdin.write(JSON.stringify({ hook_event_name: 'PreToolUse' }))
    proc.stdin.end()

    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(1)
    expect(stderr).toContain('invalid HRC_GENERATION')

    const spoolLaunchDir = join(spoolDir, 'launch-invalid-generation')
    await expect(readFile(join(spoolLaunchDir, '000001.json'), 'utf-8')).rejects.toThrow()
  })
})
