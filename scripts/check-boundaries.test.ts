import { describe, expect, test } from 'bun:test'

import { type Violation, formatBoundaryViolationDiagnostic } from './check-boundaries.ts'

describe('check-boundaries diagnostics', () => {
  test('forbidden layer imports teach fix, why, and exception path', () => {
    const violation: Violation = {
      file: 'packages/hrc-core/src/index.ts',
      specifier: 'wrkq-lib',
    }

    const diagnostic = formatBoundaryViolationDiagnostic('HRC', violation).join('\n')

    expect(diagnostic).toContain('FIX:')
    expect(diagnostic).toContain("remove the 'wrkq-lib' import")
    expect(diagnostic).toContain('WHY:')
    expect(diagnostic).toContain('HRC runtime packages must stay independent')
    expect(diagnostic).toContain('EXCEPTION:')
    expect(diagnostic).toContain('architecture approval in a wrkq task')
  })

  test('broker-scoped imports explain the broker seam', () => {
    const violation: Violation = {
      file: 'packages/hrc-server/src/broker/controller/dispatch.ts',
      specifier: '../../launch/exec.js',
      reason: 'broker-path files must not import launch/exec.ts',
    }

    const diagnostic = formatBoundaryViolationDiagnostic('HRC broker-path scoped', violation).join(
      '\n'
    )

    expect(diagnostic).toContain('FIX:')
    expect(diagnostic).toContain('broker client/protocol seam')
    expect(diagnostic).toContain('WHY:')
    expect(diagnostic).toContain('broker-path files are the runtime-control boundary')
    expect(diagnostic).toContain('EXCEPTION:')
  })
})
