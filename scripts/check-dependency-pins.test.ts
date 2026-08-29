import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type PinViolation,
  collectPinViolations,
  declarationLine,
  formatPinViolationDiagnostic,
  pinTable,
} from './check-dependency-pins.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))
  )
})

type Manifest = Record<string, unknown>

async function makeWorkspace(
  root: Manifest,
  members: Record<string, Manifest> = {}
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pin-guard-'))
  temporaryRoots.push(dir)
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(root, null, 2)}\n`)
  await mkdir(join(dir, 'packages'), { recursive: true })
  for (const [name, manifest] of Object.entries(members)) {
    await mkdir(join(dir, 'packages', name), { recursive: true })
    await writeFile(
      join(dir, 'packages', name, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
  }
  return dir
}

describe('pin table derivation', () => {
  test('governs only override entries naming one exact version', () => {
    const pins = pinTable(
      JSON.stringify({
        overrides: {
          '@types/bun': '1.3.14',
          'exact-prerelease': '2.0.0-rc.1',
          'a-range': '^1.2.3',
          'a-dist-tag': 'latest',
          'a-workspace-redirect': 'workspace:*',
          'a-file-redirect': 'file:../thing',
          'a-non-string': 5,
        },
      })
    )

    expect([...pins.entries()].sort()).toEqual([
      ['@types/bun', '1.3.14'],
      ['exact-prerelease', '2.0.0-rc.1'],
    ])
  })

  test('an empty or absent overrides block governs nothing', () => {
    expect(pinTable(JSON.stringify({})).size).toBe(0)
    expect(pinTable(JSON.stringify({ overrides: {} })).size).toBe(0)
  })
})

describe('declaration line reporting', () => {
  test('points at the dependency key rather than the top of the file', () => {
    const content = ['{', '  "devDependencies": {', '    "@types/bun": "latest"', '  }', '}'].join(
      '\n'
    )

    expect(declarationLine(content, '@types/bun')).toBe(3)
  })

  test('falls back to line 1 when the key is absent', () => {
    expect(declarationLine('{}', '@types/bun')).toBe(1)
  })
})

describe('collectPinViolations', () => {
  test('accepts a workspace whose every manifest matches the pin', async () => {
    const root = await makeWorkspace(
      { overrides: { '@types/bun': '1.3.14' }, devDependencies: { '@types/bun': '1.3.14' } },
      { 'hrc-core': { devDependencies: { '@types/bun': '1.3.14' } } }
    )

    expect(await collectPinViolations(root)).toEqual([])
  })

  test('refuses a floating specifier in a member manifest and reports its line', async () => {
    const root = await makeWorkspace(
      { overrides: { '@types/bun': '1.3.14' }, devDependencies: { '@types/bun': '1.3.14' } },
      { 'hrc-core': { devDependencies: { '@types/bun': 'latest' } } }
    )

    expect(await collectPinViolations(root)).toEqual([
      {
        manifest: 'packages/hrc-core/package.json',
        line: 3,
        section: 'devDependencies',
        dependency: '@types/bun',
        declared: 'latest',
        pinned: '1.3.14',
      },
    ])
  })

  test('refuses a caret in the ROOT manifest too — the pin table does not exempt its own file', async () => {
    const root = await makeWorkspace({
      overrides: { '@types/bun': '1.3.14' },
      devDependencies: { '@types/bun': '^1.1.14' },
    })

    const violations = await collectPinViolations(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.manifest).toBe('package.json')
    expect(violations[0]?.declared).toBe('^1.1.14')
  })

  test('governs dependencies and devDependencies but leaves peerDependencies free', async () => {
    const root = await makeWorkspace(
      { overrides: { pinned: '1.0.0' } },
      {
        runtime: { dependencies: { pinned: '2.0.0' } },
        // A peer range is a compatibility statement about the CONSUMER's tree,
        // not a resolution this workspace performs, so it is deliberately free.
        peer: { peerDependencies: { pinned: '>=1' } },
      }
    )

    expect((await collectPinViolations(root)).map((v) => v.manifest)).toEqual([
      'packages/runtime/package.json',
    ])
  })

  test('ignores dependencies the root does not pin exactly', async () => {
    const root = await makeWorkspace(
      { overrides: { ranged: '^1.0.0' } },
      { 'hrc-core': { devDependencies: { ranged: 'latest', ungoverned: 'latest' } } }
    )

    expect(await collectPinViolations(root)).toEqual([])
  })

  test('skips a packages/* directory that carries no manifest', async () => {
    const root = await makeWorkspace({ overrides: { '@types/bun': '1.3.14' } })
    await mkdir(join(root, 'packages', 'not-a-package'), { recursive: true })

    expect(await collectPinViolations(root)).toEqual([])
  })
})

describe('diagnostics', () => {
  test('teach the fix, the shadowing mechanism, and the ungovern path', () => {
    const violation: PinViolation = {
      manifest: 'packages/hrc-core/package.json',
      line: 31,
      section: 'devDependencies',
      dependency: '@types/bun',
      declared: 'latest',
      pinned: '1.3.14',
    }

    const diagnostic = formatPinViolationDiagnostic(violation).join('\n')

    expect(diagnostic).toContain('packages/hrc-core/package.json:31')
    expect(diagnostic).toContain('FIX:')
    expect(diagnostic).toContain('"@types/bun": "1.3.14"')
    expect(diagnostic).toContain('just doctor')
    expect(diagnostic).toContain('WHY:')
    expect(diagnostic).toContain('NESTED node_modules copy that shadows the root')
    expect(diagnostic).toContain('EXCEPTION:')
    expect(diagnostic).toContain('remove it from')
  })
})

describe('this repo', () => {
  test('every manifest agrees with the root pin table', async () => {
    const repoRoot = join(import.meta.dir, '..')
    expect(await collectPinViolations(repoRoot)).toEqual([])
  })

  test('pins @types/bun, the dependency this guard exists for', async () => {
    const repoRoot = join(import.meta.dir, '..')
    const pins = pinTable(await Bun.file(join(repoRoot, 'package.json')).text())
    expect(pins.get('@types/bun')).toBe('1.3.14')
  })
})
