import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type Baseline,
  type TestSource,
  findDoubleViolations,
  findDoubles,
  isTestSource,
  lowerBaseline,
  typeErrorsIn,
} from './check-test-doubles.ts'

const TEST = 'packages/p/src/__tests__/a.test.ts'
const EMPTY: Baseline = { nonconforming: {}, uncaptured: {} }
const noFixture = (): undefined => undefined

function violations(
  files: TestSource[],
  baseline: Baseline = EMPTY,
  readFixture: (path: string) => string | undefined = noFixture
) {
  return findDoubleViolations(files, baseline, readFixture, new Map()).violations
}

/** A scratch repo: a strict tsconfig, a production interface, one test file. */
async function scratchRepo(testSource: string): Promise<{ root: string; files: TestSource[] }> {
  const root = await mkdtemp(join(tmpdir(), 'hrc-test-doubles-'))
  await mkdir(join(root, 'packages/p/src/__tests__'), { recursive: true })
  await writeFile(
    join(root, 'packages/p/tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'ESNext',
        moduleResolution: 'bundler',
        target: 'ES2022',
      },
      include: ['src/**/*'],
      exclude: ['**/*.test.ts'],
    })
  )
  await writeFile(
    join(root, 'packages/p/src/api.ts'),
    'export interface Api { get(id: string): string }\n'
  )
  await writeFile(join(root, TEST), testSource)
  return { root, files: [{ path: TEST, source: testSource }] }
}

async function checkScratch(testSource: string) {
  const { root, files } = await scratchRepo(testSource)
  try {
    const errors = typeErrorsIn(root, [TEST])
    return findDoubleViolations(files, EMPTY, noFixture, errors).violations
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('what a double is', () => {
  test('test sources are __tests__, *.test.ts and *.fixture.ts under packages/ or scripts/', () => {
    expect(isTestSource('packages/p/src/__tests__/fixtures/fake-x.ts')).toBe(true)
    expect(isTestSource('packages/p/src/x.test.ts')).toBe(true)
    expect(isTestSource('scripts/x.fixture.ts')).toBe(true)
    expect(isTestSource('packages/p/src/fake-x.ts')).toBe(false)
  })

  test('a shape-defining declaration named fake*/stub*/mock*/*Double is a double', () => {
    const names = findDoubles(
      TEST,
      `
      class FakeClock {}
      function stubLocate() { return {} }
      const mockClient = { get: () => 'x' }
      const fakeRun = () => 1
      const tmuxManagerDouble = { open: () => {} }
      const fake = new FakeClock()
      const stubServer = Bun.serve({ fetch: () => new Response() })
      const fakeId = 'x'
      const faker = { a: 1 }
      function stubInstall(): void {}
      `
    ).map((double) => double.name)
    expect(names).toEqual(['FakeClock', 'stubLocate', 'mockClient', 'fakeRun', 'tmuxManagerDouble'])
  })

  test('typed means typed against a type imported from production', () => {
    const typed = findDoubles(
      TEST,
      `
      import type { Api } from '../api'
      import type { Local } from './helpers'
      import type { Pkg } from 'some-package'
      type Own = { get(): string }
      const fakeA = { get: () => 'x' } satisfies Api
      const fakeB: Pkg = { get: () => 'x' }
      class FakeC implements Partial<Api> {}
      function fakeD(): Api { return { get: () => 'x' } }
      const fakeE = { get: () => 'x' } as Api
      const fakeF = { get: () => 'x' } satisfies Own
      const fakeG = { get: () => 'x' } satisfies Local
      const fakeH: Record<string, unknown> = {}
      `
    ).map((double) => `${double.name}:${double.typed}`)
    expect(typed).toEqual([
      'fakeA:true',
      'fakeB:true',
      'FakeC:true',
      'fakeD:true',
      'fakeE:false',
      'fakeF:false',
      'fakeG:false',
      'fakeH:false',
    ])
  })
})

describe('the ratchet', () => {
  const untyped: TestSource = { path: TEST, source: 'const fakeApi = { get: () => 1 }\n' }

  test('a new untyped double fails', () => {
    const found = violations([untyped])
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('1 nonconforming double(s), baseline 0 (fakeApi:1')
  })

  test('a baselined untyped double passes, and fixing it fails until the baseline is lowered', () => {
    const baseline: Baseline = { nonconforming: { [TEST]: 1 }, uncaptured: {} }
    expect(violations([untyped], baseline)).toEqual([])
    const fixed = { path: TEST, source: '' }
    expect(violations([fixed], baseline)[0]?.message).toContain('below baseline 1')
  })

  test('the baseline only goes down', () => {
    const observed: Baseline = { nonconforming: { [TEST]: 2 }, uncaptured: {} }
    expect(lowerBaseline({ nonconforming: { [TEST]: 1 }, uncaptured: {} }, observed)).toContain(
      'above baseline 1'
    )
    expect(lowerBaseline({ nonconforming: { [TEST]: 3 }, uncaptured: {} }, observed)).toEqual(
      observed
    )
  })
})

describe('a typed double is type-checked although tsconfig excludes tests', () => {
  test('a double that satisfies its production interface passes', async () => {
    const found = await checkScratch(
      "import type { Api } from '../api'\nexport const fakeApi = { get: (id: string) => id } satisfies Api\n"
    )
    expect(found).toEqual([])
  })

  test('DELIBERATE VIOLATION: a double that disagrees with its production interface fails', async () => {
    const found = await checkScratch(
      "import type { Api } from '../api'\nexport const fakeApi = { get: (id: string) => id.length } satisfies Api\n"
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('fakeApi:2 TS2322')
  })

  test('an error outside any double does not count', async () => {
    const found = await checkScratch(
      "import type { Api } from '../api'\nconst n: number = 'x'\nexport const fakeApi = { get: (id: string) => id } satisfies Api\nexport { n }\n"
    )
    expect(found).toEqual([])
  })
})

describe('cross-project producer doubles need a captured fixture', () => {
  const PATH = 'packages/hrc-server/src/__tests__/fixtures/fake-ledger.ts'
  const FIXTURE = 'packages/hrc-server/src/__tests__/fixtures/captured/wrkq-room-say.json'
  const body = `import type { WrkqLedgerClient } from '../../wrkq/ledger-client'
export const fakeLedger = { close: async () => {} } satisfies Partial<WrkqLedgerClient>
`
  const captured = `import type { WrkqLedgerClient } from '../../wrkq/ledger-client'
/** @captured ./captured/wrkq-room-say.json */
export const fakeLedger = { close: async () => {} } satisfies Partial<WrkqLedgerClient>
`
  const reader: TestSource = {
    path: 'packages/hrc-server/src/__tests__/ledger.test.ts',
    source: "const wire = readFixture('wrkq-room-say.json')\n",
  }
  const fixture = JSON.stringify({
    producer: 'wrkq',
    producerVersion: 'wrkq 0.42.0 (abc1234)',
    capturedAt: '2026-10-04T12:00:00Z',
    request: 'wrkq rpc --stdio: {"method":"wrkq.room.say"}',
    response: { ok: true },
  })

  test('the double is classified by the import its type names', () => {
    expect(findDoubles(PATH, body)[0]?.producer).toBe('wrkq')
    const aspd =
      "import type { AspcExecutionRelease } from 'spaces-aspc-protocol'\nconst fakeRelease: AspcExecutionRelease = {} as never\n"
    expect(findDoubles(PATH, aspd)[0]?.producer).toBe('aspd')
  })

  test('a new producer double without a capture fails', () => {
    const found = violations([{ path: PATH, source: body }])
    expect(found[0]?.message).toContain('new or changed wrkq double without a captured fixture')
  })

  test('a baselined producer double passes until its text changes', () => {
    const hash = findDoubles(PATH, body)[0]?.hash
    const baseline: Baseline = { nonconforming: {}, uncaptured: { [PATH]: [`fakeLedger:${hash}`] } }
    expect(violations([{ path: PATH, source: body }], baseline)).toEqual([])
    const changed = body.replace('close: async () => {}', 'close: async () => undefined')
    const found = violations([{ path: PATH, source: changed }], baseline)
    expect(found.map((v) => v.message).join('\n')).toContain('new or changed wrkq double')
  })

  test('a capture that exists, records the producer version and is read by a test passes', () => {
    const read = (path: string) => (path === FIXTURE ? fixture : undefined)
    expect(violations([{ path: PATH, source: captured }, reader], EMPTY, read)).toEqual([])
  })

  test('a capture fails when missing, versionless, or never read by a test', () => {
    expect(violations([{ path: PATH, source: captured }, reader])[0]?.message).toContain(
      'does not exist'
    )
    const versionless = (path: string) =>
      path === FIXTURE ? JSON.stringify({ ...JSON.parse(fixture), producerVersion: '' }) : undefined
    expect(
      violations([{ path: PATH, source: captured }, reader], EMPTY, versionless)[0]?.message
    ).toContain('no "producerVersion" string')
    const read = (path: string) => (path === FIXTURE ? fixture : undefined)
    expect(violations([{ path: PATH, source: captured }], EMPTY, read)[0]?.message).toContain(
      'no test in the package reads wrkq-room-say.json'
    )
  })
})
