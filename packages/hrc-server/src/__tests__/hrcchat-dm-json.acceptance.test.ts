import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const HRCCHAT_MAIN = join(REPO_ROOT, 'packages', 'hrcchat-cli', 'src', 'main.ts')

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrcchat-dm-json-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

describe('hrcchat dm --json acceptance', () => {
  it('emits jq-parseable envelopes for multi-line stdin bodies in a fixture loop', async () => {
    const script = `
set -eu
for i in 1 2 3 4 5; do
  printf 'fixture loop %s line one\\nfixture loop %s line two\\n' "$i" "$i" |
    bun ${shellQuote(HRCCHAT_MAIN)} dm --json human -
done |
while IFS= read -r envelope; do
  printf '%s\\n' "$envelope" | jq -e . >/dev/null
done
`

    const proc = Bun.spawn({
      cmd: ['sh', '-c', script],
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ASP_PROJECT: 'agent-spaces',
        HRC_RUNTIME_DIR: fixture.runtimeRoot,
        HRC_STATE_DIR: fixture.stateRoot,
      },
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
  })
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
