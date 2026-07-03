import { describe, expect, test } from 'bun:test'

import { type MissingEdge, formatManifestEdgeDiagnostic } from './check-manifest-edges.ts'

describe('check-manifest-edges diagnostics', () => {
  test('missing workspace edges teach fix, why, and exception path', () => {
    const edge: MissingEdge = {
      packageDir: 'packages/hrc-core',
      packageName: 'hrc-core',
      dependency: 'hrc-sdk',
      files: ['packages/hrc-core/src/index.ts'],
    }

    const diagnostic = formatManifestEdgeDiagnostic(edge).join('\n')

    expect(diagnostic).toContain('FIX:')
    expect(diagnostic).toContain("declare 'hrc-sdk' in packages/hrc-core/package.json")
    expect(diagnostic).toContain('WHY:')
    expect(diagnostic).toContain('workspace resolution can hide undeclared package edges')
    expect(diagnostic).toContain('EXCEPTION:')
    expect(diagnostic).toContain('architecture approval in a wrkq task')
  })
})
