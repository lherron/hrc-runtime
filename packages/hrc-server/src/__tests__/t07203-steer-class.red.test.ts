import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import type { HarnessBrokerController } from '../broker/controller.js'
import { submitThroughBrokerDoor } from '../broker/submission-doors.js'

const source = (name: string) => readFileSync(join(import.meta.dir, '..', name), 'utf8')

function controllerDouble(result: { submissionId: string; admission: 'admitted' | 'rejected' }) {
  const calls: string[] = []
  const response = async (door: string) => {
    calls.push(door)
    return { response: result, replayed: false }
  }
  const controller = {
    steer: () => response('steer'),
    enqueue: () => response('enqueue'),
    invoke: () => response('invoke'),
    preempt: () => response('preempt'),
  } as unknown as HarnessBrokerController
  return { calls, controller }
}

const common = {
  runtimeId: 'rt-t07203',
  body: 'deliver once',
  origin: { principalRef: 'agent:cody', scopeRef: 'agent:cody:project:hrc-runtime' },
}

describe('T-07203 steer-class behavior after broker admission adoption', () => {
  it('strict steer uses only the steer door and never claims a new turn itself', async () => {
    const fake = controllerDouble({ submissionId: 'sub-steer', admission: 'admitted' })
    const result = await submitThroughBrokerDoor(fake.controller, 'steer', common)

    expect(fake.calls).toEqual(['steer'])
    expect(result.response).toEqual({ submissionId: 'sub-steer', admission: 'admitted' })
  })

  it('a rejected steer is returned honestly and is never silently upgraded to enqueue', async () => {
    const fake = controllerDouble({ submissionId: 'sub-rejected', admission: 'rejected' })
    const result = await submitThroughBrokerDoor(fake.controller, 'steer', common)

    expect(fake.calls).toEqual(['steer'])
    expect(result.response.admission).toBe('rejected')
  })

  it('ordinary semantic delivery keeps the old durable-delivery claim by selecting enqueue', () => {
    const handlers = source('target-message-handlers.ts')
    expect(handlers).toContain("submissionDoor: 'enqueue'")
    expect(handlers).not.toContain("submissionDoor: 'steer'")
  })

  it('the old reject-probe and implicit fallback claims no longer exist because admission is typed', () => {
    const doors = source('broker/submission-doors.ts')
    expect(doors).not.toContain('dispatch' + 'Input')
    expect(doors).not.toContain('steer_' + 'else_queue')
    expect(doors).not.toContain('PROBE_BUSY_' + 'REJECTED_PATTERN')
  })
})
