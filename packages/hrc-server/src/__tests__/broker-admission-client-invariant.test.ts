import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { HrcErrorCode, HrcUnprocessableEntityError } from 'hrc-core'

import { parseSubmissionRequest } from '../parsers/runtime.js'
import { isOperatorPrincipal } from '../turn-dispatch-handlers.js'

const serverSrc = join(import.meta.dir, '..')
const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
const readServer = (name: string) => readFileSync(join(serverSrc, name), 'utf8')
const readRepo = (name: string) => readFileSync(join(repoRoot, name), 'utf8')

describe('hrc-runtime.harness-broker-admission-client required tests', () => {
  it('the public HRC submission surface exposes exactly one method per admission class and all broker traffic routes through one of the four', () => {
    const controller = readServer('broker/controller.ts')
    const routes = readServer('index.ts')
    const doors = ['steer', 'enqueue', 'invoke', 'preempt'] as const
    for (const door of doors) {
      expect(controller.match(new RegExp(`async ${door}\\(`, 'g'))).toHaveLength(1)
      expect(routes).toContain(`/v1/submissions/${door}`)
    }
    expect(controller).not.toContain('dispatch' + 'Input(')
  })

  it('steer signatures cannot express wait obligation or own-response semantics', () => {
    const parsed = parseSubmissionRequest(
      { target: 'agent:cody/lane:main', body: 'x', origin: { principalRef: 'agent:cody' } },
      'steer'
    )
    expect(Object.keys(parsed).sort()).toEqual(['body', 'origin', 'target'])
    expect(() =>
      parseSubmissionRequest(
        {
          target: 'agent:cody/lane:main',
          body: 'x',
          origin: { principalRef: 'agent:cody' },
          wait: true,
        },
        'steer'
      )
    ).toThrow(HrcUnprocessableEntityError)
  })

  it('legacy whenBusy fields and implicit steer-else-queue composition are absent after adoption', () => {
    const forbidden = [
      'when' + 'Busy',
      'steer_' + 'else_queue',
      'UNSUPPORTED_' + 'WHEN_BUSY',
      'findDurable' + 'Reply',
      'PROBE_BUSY_' + 'REJECTED_PATTERN',
    ]
    const files = [
      'packages/hrc-core/src/http-contracts.ts',
      'packages/hrc-core/src/hrcchat-contracts.ts',
      'packages/hrc-server/src/messages.ts',
      'packages/hrc-server/src/turn-dispatch-handlers.ts',
      'packages/hrc-cli/src/cli/register-top.ts',
      'packages/hrc-cli/src/turn/commands/turn.ts',
    ]
    for (const file of files) {
      const source = readRepo(file)
      for (const token of forbidden) expect(source).not.toContain(token)
    }
    expect(HrcErrorCode).not.toHaveProperty('UNSUPPORTED_' + 'WHEN_BUSY')
  })

  it('obligation-bearing enqueue invoke and preempt calls correlate disposition to their originating turn terminal', () => {
    const handlers = readServer('turn-dispatch-handlers.ts')
    expect(handlers).toContain("case 'submission.executed'")
    expect(handlers).toContain("case 'submission.rejected'")
    expect(handlers).toContain("case 'submission.expired'")
    expect(handlers).toContain("case 'submission.lost'")
    expect(handlers).toContain("payload['submissionId'] !== submissionId")
    expect(handlers).toContain("payload['turnId'] !== turnId")
    expect(handlers).toContain('projectSemanticTurnResponse')
  })

  it('preempt authority and guarded-turn policy reject unauthorized or silently upgraded interrupts', () => {
    const handlers = readServer('turn-dispatch-handlers.ts')
    expect(handlers).toContain('preemptAdmission')
    expect(handlers).toContain("'authority-denied'")
    expect(handlers).toContain('.seatProbe(')
    expect(handlers).toContain('.turnManifest(')
    expect(handlers).not.toContain("door = 'preempt'")
    // T-08337: a capability refusal must NOT be reported as an authority
    // denial. The door carries two distinct reasons, and the capability one is
    // the broker's own `unsupported:preempt` — collapsing them back into a
    // single string is what this assertion exists to stop.
    expect(handlers).toContain('BROKER_PREEMPT_UNSUPPORTED_REASON')
    const capabilities = readServer('broker/capabilities.ts')
    expect(capabilities).toContain("BROKER_PREEMPT_UNSUPPORTED_REASON = 'unsupported:preempt'")
  })

  it('uses the wrkq operator principal for both run attribution and the preempt bypass', () => {
    expect(isOperatorPrincipal('agent:lance')).toBe(true)
    expect(isOperatorPrincipal('lance')).toBe(true)
    expect(isOperatorPrincipal('human:lance')).toBe(true)
    expect(isOperatorPrincipal('agent:cody')).toBe(false)

    const handlers = readServer('turn-dispatch-handlers.ts')
    expect(handlers).toContain('const kind = isOperatorPrincipal(origin.principalRef)')
    expect(handlers).toContain(
      "if (isOperatorPrincipal(request.origin.principalRef)) return 'authorized'"
    )
    // T-08337: the operator bypass outranks the AUTHORITY question but not the
    // CAPABILITY one — an operator cannot grant a driver an interrupt it does
    // not implement. So the capability gate must sit ABOVE the bypass; if a
    // future edit hoists the bypass back to the top of the function, the driver
    // receives a preempt it cannot serve and this ordering assertion fails.
    const capabilityGate = handlers.indexOf(
      "brokerRuntimeRefusesAdmissionClass(server.db, runtime, 'preempt')"
    )
    const operatorBypass = handlers.indexOf(
      "if (isOperatorPrincipal(request.origin.principalRef)) return 'authorized'"
    )
    expect(capabilityGate).toBeGreaterThan(-1)
    expect(operatorBypass).toBeGreaterThan(capabilityGate)
  })

  it('HRC policy loops consume broker capability probe queue disposition manifest and decision events without harness-internal reads', () => {
    const capabilities = readServer('broker/capabilities.ts')
    const handlers = readServer('turn-dispatch-handlers.ts')
    const mapper = readServer('broker/event-mapper.ts')
    expect(capabilities).toContain('admission?: { classes?: unknown }')
    expect(handlers).toContain('.seatProbe(')
    expect(handlers).toContain('.turnManifest(')
    for (const event of [
      'submission.executed',
      'submission.rejected',
      'submission.expired',
      'submission.lost',
    ]) {
      expect(`${handlers}\n${mapper}`).toContain(event)
    }
    expect(`${handlers}\n${mapper}`).not.toContain('capturePane')
  })
})
