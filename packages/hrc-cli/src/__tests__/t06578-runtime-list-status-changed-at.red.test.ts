import { afterAll, afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'bun:test'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import { cmdRuntimeList } from '../cli/handlers-runtime.js'

import { installOldEngineDaemon } from './old-engine-daemon.js'

const oldEngineDaemon = installOldEngineDaemon()
afterAll(() => oldEngineDaemon.stop())

// Scope the ambient daemon per-test: file execution order is not
// deterministic, so a global install alone cannot guarantee a live socket.
const runtimeDirKey = 'HRC_RUNTIME_DIR'
const savedRuntimeDir = process.env[runtimeDirKey]
beforeEach(() => {
  process.env[runtimeDirKey] = oldEngineDaemon.runtimeDir
})
afterEach(() => {
  if (savedRuntimeDir === undefined) delete process.env[runtimeDirKey]
  else process.env[runtimeDirKey] = savedRuntimeDir
})

describe('T-06578 hrc runtime list statusChangedAt exposure', () => {
  it('surfaces statusChangedAt on HrcRuntimeSnapshot and renders missing legacy values as unknown', async () => {
    expectTypeOf<HrcRuntimeSnapshot>().toHaveProperty('statusChangedAt')

    const runtime = {
      runtimeId: 'rt-status-changed-at-list',
      hostSessionId: 'hsid-status-changed-at-list',
      scopeRef: 'agent:test:project:hrc-runtime:task:T-06578',
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: '2026-07-18T10:00:00.000Z',
      updatedAt: '2026-07-18T10:02:00.000Z',
      lastActivityAt: '2026-07-18T10:01:00.000Z',
    } as HrcRuntimeSnapshot
    const chunks: string[] = []
    const originalListRuntimes = HrcClient.prototype.listRuntimes
    const originalWrite = process.stdout.write
    HrcClient.prototype.listRuntimes = (async () => [runtime]) as HrcClient['listRuntimes']
    process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer) => {
      chunks.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk as ArrayBufferView).toString()
      )
      return true
    }) as typeof process.stdout.write

    try {
      await cmdRuntimeList([])
    } finally {
      HrcClient.prototype.listRuntimes = originalListRuntimes
      process.stdout.write = originalWrite
    }

    expect(JSON.parse(chunks.join(''))[0]).toMatchObject({
      runtimeId: 'rt-status-changed-at-list',
      statusChangedAt: 'unknown',
    })
  })
})
