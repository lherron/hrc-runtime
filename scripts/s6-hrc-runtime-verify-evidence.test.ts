import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type PredicatePayload = {
  id?: string
  result?: { level?: string; exercise?: string }
  artifacts?: {
    currentRun?: {
      label?: string
      status?: number
      facts?: { verifyLeaves?: string[]; hookCommands?: string[] }
    }
    firesOnBad?: {
      label?: string
      expected?: string
      observed?: string
      perturbation?: string
      diagnostic?: { code?: string }
    }
  }
}

type PredicateModule = {
  evaluateHrcRuntimeVerifyEvidence?: (options: { root: string }) =>
    | PredicatePayload
    | Promise<PredicatePayload>
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
}

function hrcRuntimeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hrc-runtime-s6-verify-'))

  write(
    root,
    'justfile',
    `
check:
    bun scripts/check-boundaries.ts
    bun scripts/check-manifest-edges.ts
    bun scripts/check-cli-surface.ts
    bun scripts/check-public-surface.ts
    bun scripts/check-suppressions.ts

lint:
    bun run lint

typecheck:
    bun run typecheck

test:
    bun run test

verify: check lint typecheck test
`.trimStart()
  )

  write(
    root,
    'lefthook.yml',
    `
pre-commit:
  parallel: false
  commands:
    lint:
      run: bun run lint
    boundaries:
      run: bun scripts/check-boundaries.ts
    manifests:
      run: bun scripts/check-manifest-edges.ts
    cli-surface:
      run: bun scripts/check-cli-surface.ts
    public-surface:
      run: bun scripts/check-public-surface.ts
    suppressions:
      run: bun scripts/check-suppressions.ts
    typecheck:
      run: bun run build && bun run typecheck

pre-push:
  parallel: false
  commands:
    test:
      run: bun run test:fast
`.trimStart()
  )

  return root
}

describe('S6 hrc-runtime verify evidence predicate', () => {
  test('records currentRun and firesOnBad artifacts for the lefthook-to-verify closure', async () => {
    const root = hrcRuntimeFixture()
    try {
      let mod: PredicateModule | undefined
      try {
        mod = await import('../tools/fitkit/s6-hrc-runtime-verify-evidence.mjs')
      } catch {
        mod = undefined
      }

      // Red bar for T-05800: hrc-runtime needs a first-party fitkit predicate
      // that makes the current hook/verify closure and a bad-hook perturbation
      // reusable evidence, instead of leaving future agents to reconstruct it
      // from scrollback or one-off manual runs.
      expect(mod?.evaluateHrcRuntimeVerifyEvidence).toBeFunction()

      const payload = await mod!.evaluateHrcRuntimeVerifyEvidence!({ root })

      expect(payload.id).toBe('fit:s6/hrc-runtime-lefthook-verify-closure')
      expect(payload.result).toEqual({ level: 'PRESENT', exercise: 'EXERCISED' })

      expect(payload.artifacts?.currentRun).toMatchObject({
        label: 'currentRun',
        status: 0,
      })
      expect(payload.artifacts?.currentRun?.facts?.verifyLeaves).toEqual([
        'check:boundaries',
        'check:cli-surface',
        'check:manifests',
        'check:public-surface',
        'check:suppressions',
        'lint',
        'test',
        'typecheck',
      ])
      expect(payload.artifacts?.currentRun?.facts?.hookCommands).toEqual(
        expect.arrayContaining([
          'bun scripts/check-boundaries.ts',
          'bun scripts/check-cli-surface.ts',
          'bun scripts/check-manifest-edges.ts',
          'bun scripts/check-public-surface.ts',
          'bun scripts/check-suppressions.ts',
          'bun run lint',
          'bun run test:fast',
          'bun run build && bun run typecheck',
        ])
      )

      expect(payload.artifacts?.firesOnBad).toMatchObject({
        label: 'firesOnBad',
        expected: 'FAIL',
        observed: 'FAIL',
        perturbation: 'remove-hook-command:test',
        diagnostic: { code: 'hook.verify-closure.missing' },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
