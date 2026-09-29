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
  // T-08533: steer joins the running turn or starts one, so it has a turn to
  // wait on. It still cannot carry TTL or a turn policy.
  it('steer may carry wait, but never TTL or a turn policy', () => {
    expect(parseSubmissionRequest({ ...base, wait: true }, 'steer')).toEqual({
      ...base,
      wait: true,
    })
    expect(() => parseSubmissionRequest({ ...base, ttlMs: 30_000 }, 'steer')).toThrow(
      HrcUnprocessableEntityError
    )
    expect(() => parseSubmissionRequest({ ...base, turnPolicy: 'guarded' }, 'steer')).toThrow(
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
    const handlers = [
      source('packages/hrc-server/src/target-message-dm-handlers.ts'),
      source('packages/hrc-server/src/target-message-handoff-handlers.ts'),
    ].join('\n')
    expect(handlers).toContain("submissionDoor: 'enqueue'")
    expect(handlers).not.toContain("submissionDoor: 'preempt'")
  })

  it('the retired urgent alias has no CLI path; explicit steer and preempt select distinct doors', () => {
    const registration = source('packages/hrc-cli/src/cli/register-top.ts')
    const command = `${source('packages/hrc-cli/src/turn/commands/turn.ts')}
${source('packages/hrc-cli/src/turn/commands/turn-dispatch.ts')}`
    expect(`${registration}\n${command}`).not.toContain('--' + 'urgent')
    expect(registration).toMatch(/\.option\(\s*'--steer'/)
    expect(registration).toMatch(/\.option\(\s*'--queue'/)
    expect(registration).toContain(".option('--preempt'")
    expect(command).toContain('client.steer(')
    expect(command).toContain('client.preempt(')
  })

  it('single-actuation authority moved from the HRC idempotency ledger to broker submission identity', () => {
    const contracts = source('packages/hrc-core/src/http-contracts-dispatch.ts')
    const controller = [
      'controller.ts',
      'controller/bc-submission.ts',
      'controller/bc-attach.ts',
      'controller/bc-rpc.ts',
      'controller/bc-events.ts',
      'controller/bc-projection.ts',
      'controller/bc-close.ts',
    ]
      .map((name) => source(`packages/hrc-server/src/broker/${name}`))
      .join('\n')
    expect(contracts).toContain('submissionId: string')
    expect(controller).not.toContain('steerDeliveryAttempts')
  })
})
