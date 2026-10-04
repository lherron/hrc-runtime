import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurnAdmissionGate } from '../../turn-admission-gate'
import { ADMISSION_STEPS, runLeasedAdmission } from '../admit'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function gate() {
  const root = await mkdtemp(join(tmpdir(), 'admission-'))
  roots.push(root)
  return new TurnAdmissionGate(root)
}

test('drain closure waits until the route settles; new work refuses with nine steps', async () => {
  const admissionGate = await gate()
  let settle!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = runLeasedAdmission(
    { gate: admissionGate, record: () => {} },
    {
      steps: ADMISSION_STEPS.slice(1).map((step) => ({
        step,
        run: async () => ({ outcome: 'passed' as const }),
      })),
      route: async () => {
        entered()
        await new Promise<void>((resolve) => {
          settle = resolve
        })
        return { kind: 'accepted', value: 'receipt' }
      },
    }
  )
  await started
  let closed = false
  const closure = admissionGate.close({ operationId: 'test-close' }).then(() => {
    closed = true
  })
  const refused = await runLeasedAdmission(
    { gate: admissionGate, record: () => {} },
    {
      steps: [],
      route: async () => {
        throw new Error('must not route')
      },
    }
  )
  expect(refused.outcome).toBe('refused')
  expect(refused.trace.map((item) => item.step)).toEqual(ADMISSION_STEPS)
  expect(closed).toBe(false)
  settle()
  expect((await pending).outcome).toBe('routed')
  await closure
  expect(admissionGate.snapshot().activeAdmissions).toBe(0)
})

for (const cause of ['write-then-throw', 'timeout', 'cancelled']) {
  test(`${cause} after preflight remains possible_write without altering route state`, async () => {
    const admissionGate = await gate()
    const input = { protected: true, terminal: false, landed: false }
    const events: string[] = []
    const result = await runLeasedAdmission(
      {
        gate: admissionGate,
        record: (result) => {
          events.push(result.outcome)
        },
      },
      {
        steps: ADMISSION_STEPS.slice(1).map((step) => ({
          step,
          run: async () => ({ outcome: 'passed' as const }),
        })),
        route: async () => {
          input.landed = true
          throw new Error(cause)
        },
      }
    )
    expect(result.outcome).toBe('possible_write')
    expect(input).toEqual({ protected: true, terminal: false, landed: true })
    expect(events).toEqual(['possible_write'])
    expect(admissionGate.snapshot().activeAdmissions).toBe(0)
  })
}

test('caller cancellation after preflight retains the lease until the route settles', async () => {
  const admissionGate = await gate()
  const cancellation = new AbortController()
  let entered!: () => void
  let settle!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = runLeasedAdmission(
    { gate: admissionGate, record: () => {} },
    {
      signal: cancellation.signal,
      steps: ADMISSION_STEPS.slice(1).map((step) => ({
        step,
        run: async () => ({ outcome: 'passed' as const }),
      })),
      route: async () => {
        entered()
        await new Promise<void>((resolve) => {
          settle = resolve
        })
        return { kind: 'accepted', value: 'landed receipt' }
      },
    }
  )
  await started
  cancellation.abort(new Error('caller cancelled'))
  let closed = false
  const closure = admissionGate.close({ operationId: 'cancel-close' }).then(() => {
    closed = true
  })
  expect(closed).toBe(false)
  expect(admissionGate.snapshot().activeAdmissions).toBe(1)
  settle()
  expect((await pending).outcome).toBe('possible_write')
  await closure
  expect(admissionGate.snapshot().activeAdmissions).toBe(0)
})
