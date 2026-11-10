import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type Violation,
  collectRequiredTsFiles,
  formatBoundaryViolationDiagnostic,
  isForbidden,
  layers,
} from './check-boundaries.ts'

describe('check-boundaries diagnostics', () => {
  test('declared scan groups fail closed when they resolve to zero TypeScript inputs', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'hrc-boundaries-'))
    const emptyRoot = join(fixtureRoot, 'empty')
    await mkdir(emptyRoot)

    try {
      await expect(
        collectRequiredTsFiles('missing fixture', [join(fixtureRoot, 'missing')])
      ).rejects.toThrow('missing fixture')
      await expect(collectRequiredTsFiles('empty fixture', [emptyRoot])).rejects.toThrow(
        'empty fixture'
      )
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
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

  test('HRC rejects injector package imports after the ACP cutover', () => {
    const hrcLayer = layers.find((layer) => layer.name === 'HRC')

    expect(hrcLayer?.forbidden).toEqual(
      expect.arrayContaining(['hrc-injector-core', 'hrc-mail-injector'])
    )
    expect(isForbidden('hrc-mail-injector', 'hrc-mail-injector')).toBe(true)
    expect(isForbidden('hrc-injector-core/policy', 'hrc-injector-core')).toBe(true)
  })
})
