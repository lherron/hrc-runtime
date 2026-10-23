import { expect, test } from 'bun:test'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { compilerPrimingSubmissionId } from '../compiler-priming.js'

test('reads compiler priming from the frozen v2 operation admission', () => {
  const db = {
    runtimeOperations: {
      getByOperationId: () => ({
        preparationJson: JSON.stringify({
          admission: {
            plan: { schemaVersion: 'agent-runtime-plan/v2' },
            execution: {
              dispatchRequest: { startRequest: { initialInput: { inputId: 'priming-v2' } } },
            },
          },
        }),
      }),
    },
  } as unknown as HrcDatabase
  const runtime = {
    activeOperationId: 'operation-v2',
    planHash: 'plan-v2',
    selectedProfileHash: 'opaque-attach-fence',
  } as HrcRuntimeSnapshot

  expect(compilerPrimingSubmissionId(db, runtime)).toBe('priming-v2')
})
