import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { HrcClient } from 'hrc-sdk'

import { cmdCaptureStatus } from '../cli/handlers-capture.js'

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

const RUNTIME_ID = 'rt-11111111-1111-4111-8111-111111111111'
const ENVELOPE_KEYS = [
  'HRC_SESSION_REF',
  'HRC_RUN_ID',
  'HRC_HOST_SESSION_ID',
  'AGENT_HOST_SESSION_ID',
  'HRC_GENERATION',
  'AGENT_GENERATION',
  'ASP_SCOPE_REF',
  'ASP_TASK_ID',
  'ASP_DEFAULT_TASK',
  'ASP_HANDLE',
] as const

const originalEnvelope = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENVELOPE_KEYS) {
    originalEnvelope.set(key, process.env[key])
    Reflect.deleteProperty(process.env, key)
  }
  spyOn(HrcClient.prototype, 'listRuntimes').mockResolvedValue([])
})

afterEach(() => {
  mock.restore()
  for (const key of ENVELOPE_KEYS) {
    const value = originalEnvelope.get(key)
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key)
    } else {
      process.env[key] = value
    }
  }
  originalEnvelope.clear()
})

function captureStdout(): { read(): string; restore(): void } {
  const chunks: string[] = []
  const original = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write
  return {
    read: () => chunks.join(''),
    restore: () => {
      process.stdout.write = original
    },
  }
}

describe('hrc capture control', () => {
  test('renders broker-authoritative capture status', async () => {
    const capture = {
      state: 'blocked' as const,
      blockedOn: {
        rawRecordId: 'raw-cli',
        nativeType: 'queue.future_op',
        family: 'input-admission' as const,
        message: 'unknown queue operation',
        sinceIso: '2026-09-01T19:00:00.000Z',
      },
      deferredCount: 1,
    }
    spyOn(HrcClient.prototype, 'brokerCaptureStatus').mockResolvedValue({
      runtimeId: RUNTIME_ID,
      capture,
    })
    const output = captureStdout()
    try {
      await cmdCaptureStatus([RUNTIME_ID])
      expect(output.read()).toContain(
        'capture: blocked since 2026-09-01T19:00:00.000Z on raw-cli (input-admission/queue.future_op): unknown queue operation (deferredCount=1)'
      )
    } finally {
      output.restore()
    }
  })
})
