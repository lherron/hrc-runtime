/**
 * Unit tests for shutdown-intent attribution. The CLI writes a short-lived
 * intent file before signalling the daemon; the daemon's shutdown handler
 * consumes it to attribute `server.shutting_down` to the initiating agent.
 * We isolate the runtime root via HRC_RUNTIME_DIR so the live daemon's file
 * is never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { consumeShutdownIntent, writeShutdownIntent } from '../cli-runtime'

let dir: string
let prevRuntimeDir: string | undefined
let prevSessionRef: string | undefined
let prevRunId: string | undefined

const intentPath = () => join(dir, 'shutdown-intent.json')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shutdown-intent-'))
  prevRuntimeDir = process.env['HRC_RUNTIME_DIR']
  prevSessionRef = process.env['HRC_SESSION_REF']
  prevRunId = process.env['HRC_RUN_ID']
  process.env['HRC_RUNTIME_DIR'] = dir
})

afterEach(async () => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  restore('HRC_RUNTIME_DIR', prevRuntimeDir)
  restore('HRC_SESSION_REF', prevSessionRef)
  restore('HRC_RUN_ID', prevRunId)
  await rm(dir, { recursive: true, force: true })
})

describe('shutdown intent', () => {
  it('round-trips the initiating agent identity', () => {
    process.env['HRC_SESSION_REF'] = 'agent:larry:project:hrc-runtime:task:T-01854/lane:main'
    process.env['HRC_RUN_ID'] = 'run-5da14a6b'

    writeShutdownIntent('restart')
    expect(existsSync(intentPath())).toBe(true)

    const intent = consumeShutdownIntent()
    expect(intent).toBeDefined()
    expect(intent?.action).toBe('restart')
    expect(intent?.requestedBy).toBe('agent:larry:project:hrc-runtime:task:T-01854/lane:main')
    expect(intent?.requestedRunId).toBe('run-5da14a6b')
    expect(intent?.byPid).toBe(process.pid)
  })

  it('consuming deletes the file (single-shot)', () => {
    writeShutdownIntent('stop')
    expect(consumeShutdownIntent()).toBeDefined()
    expect(existsSync(intentPath())).toBe(false)
    expect(consumeShutdownIntent()).toBeUndefined()
  })

  it('records null identity when env is unset (external/manual stop)', () => {
    delete process.env['HRC_SESSION_REF']
    delete process.env['HRC_RUN_ID']
    writeShutdownIntent('stop')
    const intent = consumeShutdownIntent()
    expect(intent?.requestedBy).toBeNull()
    expect(intent?.requestedRunId).toBeNull()
  })

  it('returns undefined when no intent file exists', () => {
    expect(consumeShutdownIntent()).toBeUndefined()
  })

  it('ignores a stale intent file beyond the freshness window', () => {
    const stale = {
      action: 'restart',
      requestedBy: 'agent:larry:project:hrc-runtime:task:T-01854',
      requestedRunId: null,
      byPid: 1234,
      at: new Date(Date.now() - 60_000).toISOString(),
    }
    writeFileSync(intentPath(), JSON.stringify(stale))
    // Stale => not returned, but still consumed (deleted) so it can't linger.
    expect(consumeShutdownIntent(30_000)).toBeUndefined()
    expect(existsSync(intentPath())).toBe(false)
  })

  it('ignores a corrupt intent file without throwing', () => {
    writeFileSync(intentPath(), '{not json')
    expect(consumeShutdownIntent()).toBeUndefined()
    expect(existsSync(intentPath())).toBe(false)
  })
})
