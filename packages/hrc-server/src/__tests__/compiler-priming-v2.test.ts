import { expect, test } from 'bun:test'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { compilerPrimingSubmissionId } from '../compiler-priming.js'

test('reads compiler priming only from the singular v2 execution dispatch request', () => {
  const db = {
    compiledRuntimePlans: {
      getByPlanHash: () => ({
        planProjectionJson: JSON.stringify({
          schemaVersion: 'agent-runtime-plan/v2',
          execution: {
            dispatchRequest: { startRequest: { initialInput: { inputId: 'priming-v2' } } },
          },
        }),
      }),
    },
  } as unknown as HrcDatabase
  const runtime = {
    planHash: 'plan-v2',
    selectedProfileHash: 'opaque-attach-fence',
  } as HrcRuntimeSnapshot

  expect(compilerPrimingSubmissionId(db, runtime)).toBe('priming-v2')
})

test('does not reinterpret a retained v1 plan as a v2 priming operation', () => {
  const db = {
    compiledRuntimePlans: {
      getByPlanHash: () => ({
        planProjectionJson: JSON.stringify({
          schemaVersion: 'agent-runtime-plan/v1',
          executionProfiles: [
            {
              profileHash: 'legacy',
              harnessInvocation: { startRequest: { initialInput: { inputId: 'x' } } },
            },
          ],
        }),
      }),
    },
  } as unknown as HrcDatabase
  const runtime = {
    planHash: 'plan-v1',
    selectedProfileHash: 'legacy',
  } as HrcRuntimeSnapshot

  expect(compilerPrimingSubmissionId(db, runtime)).toBeUndefined()
})
