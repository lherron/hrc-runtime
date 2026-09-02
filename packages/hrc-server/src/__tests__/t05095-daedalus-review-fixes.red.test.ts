import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { HrcErrorCode, HrcUnprocessableEntityError } from 'hrc-core'

import { brokerCapabilitiesSupportAdmissionClass } from '../broker/capabilities.js'
import { parseDispatchTurnRequest } from '../parsers/runtime.js'

const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
const source = (name: string) => readFileSync(join(repoRoot, name), 'utf8')

const dispatch = {
  hostSessionId: 'hsid-t05095',
  prompt: 'submit this turn',
}

describe('T-05095 admission findings after the broker owns admission', () => {
  it('a legacy busy-policy field is rejected as unknown before any broker call can occur', () => {
    expect(() => parseDispatchTurnRequest({ ...dispatch, ['when' + 'Busy']: 'queue' })).toThrow(
      HrcUnprocessableEntityError
    )
    try {
      parseDispatchTurnRequest({ ...dispatch, ['when' + 'Busy']: 'queue' })
    } catch (error) {
      expect(error).toMatchObject({ code: HrcErrorCode.UNKNOWN_FIELD })
    }
  })

  it('queue admission is learned from the broker hello projection, never the local run table', () => {
    expect(
      brokerCapabilitiesSupportAdmissionClass(
        JSON.stringify({ admission: { classes: ['steer', 'queue', 'exclusive'] } }),
        'queue'
      )
    ).toBe(true)
    expect(
      brokerCapabilitiesSupportAdmissionClass(
        JSON.stringify({ admission: { classes: ['steer'] } }),
        'queue'
      )
    ).toBe(false)
  })

  it('interactive queue preservation is now an explicit enqueue syscall', () => {
    const doors = source('packages/hrc-server/src/broker/submission-doors.ts')
    expect(doors).toContain("case 'enqueue':")
    expect(doors).toContain('return controller.enqueue({')
  })

  it('the old regex reject probe is absent because typed dispositions are authoritative', () => {
    const handlers = source('packages/hrc-server/src/turn-dispatch-handlers.ts')
    expect(handlers).not.toContain('PROBE_BUSY_' + 'REJECTED_PATTERN')
    expect(handlers).toContain("case 'submission.rejected'")
  })
})

describe('T-05095 repair and correlation regression guards', () => {
  it('repair metadata remains write-time envelope authority', () => {
    const handlers = source('packages/hrc-server/src/turn-dispatch-handlers.ts')
    const repository = source('packages/hrc-store-sqlite/src/repositories/broker-repositories.ts')
    expect(handlers).toContain('repairRunId')
    expect(repository).toContain('enrichEnvelopeJsonWithRepairCorrelation')
    expect(repository).toContain('broker_envelope_json')
  })

  it('admission run correlation is keyed by broker submission identity', () => {
    const repository = source('packages/hrc-store-sqlite/src/repositories/runtime-repositories.ts')
    expect(repository).toContain('getByBrokerSubmissionId(submissionId: string)')
    expect(repository).toContain('broker_submission_id')
  })
})
