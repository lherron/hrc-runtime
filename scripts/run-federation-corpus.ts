import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'loopback' && mode !== 'live') {
  console.error('usage: bun scripts/run-federation-corpus.ts <loopback|live> [test-name-pattern]')
  process.exit(2)
}

const testNamePattern = process.argv[3] ?? String.raw`\[federation corpus\]`
const repoRoot = import.meta.dir.replace(/\/scripts$/, '')
const testsRoot = join(repoRoot, 'packages', 'hrc-server', 'src', '__tests__')
const consumerFiles: string[] = []
const testFiles = new Bun.Glob('**/*.test.ts')
for await (const relativePath of testFiles.scan(testsRoot)) {
  const file = join(testsRoot, relativePath)
  const source = await readFile(file, 'utf8')
  if (/\bconst\s+\w+\s*=\s*selectLiveTailnetTest\(/.test(source)) consumerFiles.push(file)
}
consumerFiles.sort()
if (consumerFiles.length === 0) {
  console.error('[HRC_FEDERATION_CORPUS_DISCOVERY_EMPTY] no fixture consumers were discovered')
  process.exit(1)
}

const counterRoot = await mkdtemp(join(tmpdir(), 'hrc-federation-corpus-'))
const counterFile = join(counterRoot, 'executed.tsv')
const env = {
  ...process.env,
  HRC_FEDERATION_CASE_COUNTER_FILE: counterFile,
  ...(mode === 'loopback'
    ? { HRC_FEDERATION_TEST_MODE: 'loopback' }
    : { HRC_REQUIRE_LIVE_TAILNET_TESTS: '1' }),
}

try {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'test',
      '--timeout',
      '10000',
      '--test-name-pattern',
      testNamePattern,
      ...consumerFiles,
    ],
    cwd: repoRoot,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const status = await child.exited
  const executed = await readFile(counterFile, 'utf8')
    .then((contents) => contents.split('\n').filter((line) => line.length > 0))
    .catch(() => [])

  console.info(`[HRC_FEDERATION_${mode.toUpperCase()}_CASES_EXECUTED] ${executed.length}`)
  if (mode === 'loopback' && executed.length === 0) {
    console.error('[HRC_FEDERATION_LOOPBACK_ZERO_CASES] no loopback federation cases executed')
    process.exit(1)
  }
  if (status !== 0) process.exit(status)
} finally {
  await rm(counterRoot, { recursive: true, force: true })
}
