import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { HrcUnprocessableEntityError } from 'hrc-core'

import { parseSubmissionRequest } from '../parsers/runtime.js'

const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
const source = (name: string) => readFileSync(join(repoRoot, name), 'utf8')

const base = {
  target: 'agent:cody:project:hrc-runtime/lane:main',
  body: 'door-selected delivery',
  origin: { principalRef: 'agent:cody', scopeRef: 'agent:cody:project:hrc-runtime' },
}

describe('T-07155 delivery claims in the four-door vocabulary', () => {
  it('steer cannot carry wait, so a caller cannot accidentally turn an absorbed prompt into an obligation', () => {
    expect(() => parseSubmissionRequest({ ...base, wait: true }, 'steer')).toThrow(
      HrcUnprocessableEntityError
    )
  })

  it('an enqueue can carry TTL and guarded policy and therefore owns its eventual turn', () => {
    expect(
      parseSubmissionRequest(
        { ...base, ttlMs: 30_000, turnPolicy: 'guarded', wait: true },
        'enqueue'
      )
    ).toEqual({ ...base, ttlMs: 30_000, turnPolicy: 'guarded', wait: true })
  })

  it('semantic DM delivery remains durable by selecting enqueue exactly, never steer or preempt', () => {
    const handlers = source('packages/hrc-server/src/target-message-handlers.ts')
    expect(handlers).toContain("submissionDoor: 'enqueue'")
    expect(handlers).not.toContain("submissionDoor: 'preempt'")
  })

  it('the retired urgent alias has no CLI path; explicit steer and preempt select distinct doors', () => {
    const command = source('packages/hrcchat-cli/src/commands/turn.ts')
    expect(command).not.toContain('--' + 'urgent')
    expect(command).toContain('client.steer(')
    expect(command).toContain('client.preempt(')
  })

  it('single-actuation authority moved from the HRC idempotency ledger to broker submission identity', () => {
    const contracts = source('packages/hrc-core/src/http-contracts.ts')
    const controller = source('packages/hrc-server/src/broker/controller.ts')
    expect(contracts).toContain('submissionId: string')
    expect(controller).not.toContain('steerDeliveryAttempts')
  })
})
