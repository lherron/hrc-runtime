import { describe, expect, test } from 'bun:test'

import {
  type Violation,
  findHrcViewerSdkViolations,
  findMailScopedViolation,
  formatBoundaryViolationDiagnostic,
} from './check-boundaries.ts'

describe('check-boundaries diagnostics', () => {
  test('hrc-viewer uses only its §5.4 side-effect-free SDK allowlist', async () => {
    expect(await findHrcViewerSdkViolations()).toEqual([])
  })

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

  // The companion ingress guard died with packages/hrc-server/src/mail at the
  // T-07612 flag day, and findMailScopedViolation lost its layer argument with
  // it. Only mail persistence still has files to guard.
  test('mail persistence scoped guard keeps server orchestration out', () => {
    expect(
      findMailScopedViolation(
        'packages/hrc-store-sqlite/src/mail/envelope-repository.ts',
        'hrc-server'
      )
    ).toContain('persistence')
    expect(
      findMailScopedViolation(
        'packages/hrc-store-sqlite/src/mail/envelope-repository.ts',
        'hrc-server/dist/broker.js'
      )
    ).toContain('persistence')
    expect(
      findMailScopedViolation(
        'packages/hrc-store-sqlite/src/mail/envelope-repository.ts',
        './reply-schema.js'
      )
    ).toBeUndefined()
  })
})
