import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import { cmdCaptureRelease, cmdCaptureStatus } from '../cli/handlers-capture.js'

const RUNTIME_ID = 'rt-11111111-1111-4111-8111-111111111111'
const ENVELOPE_KEYS = [
  'HRC_SESSION_REF',
  'HRC_RUN_ID',
  'ASP_SCOPE_REF',
  'ASP_TASK_ID',
  'ASP_DEFAULT_TASK',
  'ASP_HANDLE',
] as const

const originalEnvelope = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENVELOPE_KEYS) {
    originalEnvelope.set(key, process.env[key])
    process.env[key] = undefined
  }
  spyOn(HrcClient.prototype, 'listRuntimes').mockResolvedValue([])
})

afterEach(() => {
  mock.restore()
  for (const key of ENVELOPE_KEYS) {
    const value = originalEnvelope.get(key)
    process.env[key] = value
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

  test('sends the exact normalized-as request with a human operator principal', async () => {
    const release = spyOn(HrcClient.prototype, 'brokerCaptureRelease').mockResolvedValue({
      released: true,
      invocationId: 'invocation-cli' as never,
      rawRecordId: 'raw-cli',
      disposition: 'normalized',
      releasedSeq: 23,
      normalizedSeq: 22,
      resumedRecords: 1,
      capture: { state: 'open', deferredCount: 0 },
    })
    const output = captureStdout()
    try {
      await cmdCaptureRelease([
        RUNTIME_ID,
        '--raw-record',
        'raw-cli',
        '--disposition',
        'normalized-as',
        '--event-type',
        'driver.notice',
        '--event-payload',
        '{"message":"known native row"}',
        '--turn-id',
        'turn-cli',
        '--note',
        'operator disposition',
      ])
      expect(release).toHaveBeenCalledTimes(1)
      const request = release.mock.calls[0]?.[0]
      expect(request).toMatchObject({
        runtimeId: RUNTIME_ID,
        rawRecordId: 'raw-cli',
        disposition: 'normalized-as',
        normalizedAs: {
          type: 'driver.notice',
          payload: { message: 'known native row' },
          turnId: 'turn-cli',
        },
        note: 'operator disposition',
      })
      expect(request?.operatorPrincipal).toMatch(/^human(?::|$)/)
      expect(JSON.parse(output.read())).toMatchObject({ released: true, releasedSeq: 23 })
    } finally {
      output.restore()
    }
  })

  test('refuses a scoped runtime and preserves raw_record_not_blocked from HRC', async () => {
    process.env['HRC_SESSION_REF'] = 'agent:cody:project:hrc-runtime:task:T-07864~main'
    process.env['ASP_SCOPE_REF'] = 'agent:cody:project:hrc-runtime:task:T-07864'
    const release = spyOn(HrcClient.prototype, 'brokerCaptureRelease')

    await expect(
      cmdCaptureRelease([RUNTIME_ID, '--raw-record', 'raw-cli', '--disposition', 'ignored-known'])
    ).rejects.toThrow(/operator shell|task-scoped runtime/)
    expect(release).not.toHaveBeenCalled()

    process.env['HRC_SESSION_REF'] = undefined
    process.env['ASP_SCOPE_REF'] = undefined
    release.mockRejectedValue(
      new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, 'raw_record_not_blocked', {
        reason: 'raw_record_not_blocked',
      })
    )
    await expect(
      cmdCaptureRelease([RUNTIME_ID, '--raw-record', 'raw-cli', '--disposition', 'ignored-known'])
    ).rejects.toMatchObject({
      message: 'raw_record_not_blocked',
      detail: { reason: 'raw_record_not_blocked' },
    })
  })
})
