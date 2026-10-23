/**
 * Server lock vs. pid reuse across a reboot.
 *
 * hrcdev sat down for 3.3 days (2026-10-20 → 23): its server.lock named pid 501
 * from before the reboot, macOS handed 501 to akd, and every launchd respawn
 * refused "already running" because the pid was alive. A lock created before the
 * current boot cannot belong to a live server, whatever process holds its pid now.
 *
 * Failure modes:
 *   1. Lock predates boot, pid alive (reused), socket dead → must acquire.
 *   2. Lock created after boot, pid alive, socket dead → must still refuse
 *      (a real server can hold the lock before its socket is bound).
 *   3. Legacy lock without createdAt, pid alive → must still refuse.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireServerLock } from '../server-lock.js'
import type { HrcServerOptions } from '../server-types.js'

let root: string
let options: HrcServerOptions

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hrc-lock-pid-reuse-'))
  options = {
    lockPath: join(root, 'server.lock'),
    socketPath: join(root, 'hrc.sock'),
  } as HrcServerOptions
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// The test process itself stands in for "some live process now holding the pid".
const livePid = process.pid

describe('acquireServerLock with a live pid in the lock', () => {
  it('acquires when the lock was created before this boot (pid reused)', async () => {
    await writeFile(
      options.lockPath,
      `${JSON.stringify({ pid: livePid, createdAt: '2000-01-01T00:00:00.000Z' })}\n`
    )

    const handle = await acquireServerLock(options)

    expect(handle.owner.pid).toBe(process.pid)
    const written = JSON.parse(await readFile(options.lockPath, 'utf-8'))
    expect(written.createdAt).toBe(handle.owner.createdAt)
  })

  it('still refuses when the lock was created after this boot', async () => {
    await writeFile(
      options.lockPath,
      `${JSON.stringify({ pid: livePid, createdAt: new Date().toISOString() })}\n`
    )

    await expect(acquireServerLock(options)).rejects.toThrow('already running with lock')
  })

  it('still refuses a legacy lock with no createdAt', async () => {
    await writeFile(options.lockPath, `${livePid}\n`)

    await expect(acquireServerLock(options)).rejects.toThrow('already running with lock')
  })
})
