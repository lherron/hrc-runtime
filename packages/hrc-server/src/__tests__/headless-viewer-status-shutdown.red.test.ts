/**
 * RED regression for T-05834 cycle 2.
 *
 * The full worktree verifier exposed a teardown race after `hrc runtime ensure`:
 * a debounced headless-viewer status projection survived `server.stop()`, woke
 * after SQLite was closed, and logged `Cannot use a closed database`. Shutdown
 * must cancel this cosmetic projection before closing the server DB.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'

let tmpDir: string | undefined
let server: HrcServer | undefined

afterEach(async () => {
  if (server) {
    await server.stop().catch(() => undefined)
    server = undefined
  }
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  }
})

async function makeServer(): Promise<HrcServer> {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-status-shutdown-'))
  const runtimeRoot = join(tmpDir, 'runtime')
  const stateRoot = join(tmpDir, 'state')
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })

  return await createHrcServer({
    runtimeRoot,
    stateRoot,
    socketPath: join(runtimeRoot, 'hrc.sock'),
    lockPath: join(runtimeRoot, 'server.lock'),
    spoolDir: join(runtimeRoot, 'spool'),
    dbPath: join(stateRoot, 'state.sqlite'),
    tmuxSocketPath: join(runtimeRoot, 'tmux.sock'),
  })
}

function captureServerStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(Buffer.from(chunk).toString('utf8'))
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stderr.write
  return {
    lines,
    restore: () => {
      process.stderr.write = original
    },
  }
}

describe('headless viewer status shutdown', () => {
  it('cancels pending status projections before closing the server database', async () => {
    const stderr = captureServerStderr()
    try {
      server = await makeServer()
      ;(
        server as unknown as {
          notifyEvent: (event: { eventKind: string; runtimeId: string; scopeRef: string }) => void
        }
      ).notifyEvent({
        eventKind: 'turn.started',
        runtimeId: 'rt-status-shutdown',
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-05834',
      })

      await server.stop()
      server = undefined
      await new Promise((resolve) => setTimeout(resolve, 250))
    } finally {
      stderr.restore()
    }

    expect(stderr.lines.join('')).not.toContain('Cannot use a closed database')
  })
})
