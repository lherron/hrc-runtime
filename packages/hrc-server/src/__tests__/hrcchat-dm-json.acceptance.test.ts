import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

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

  it('emits strict one-line JSON with escaped multi-line request bodies when the target runtime is busy', async () => {
    await seedBusyRuntime()

    const result = await runDmJson('cody@agent-spaces:T-01303', 'line 1\nline 2\nline 3\n')
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.endsWith('\n')).toBe(true)

    const serialized = result.stdout.slice(0, -1)
    expect(serialized).not.toContain('\n')
    expect(serialized).toContain(String.raw`line 1\nline 2\nline 3\n`)
    await expectJqParses(serialized)

    const envelope = JSON.parse(serialized) as Record<string, unknown>
    const request = envelope['request'] as Record<string, unknown>
    const execution = request['execution'] as Record<string, unknown>
    expect(execution['errorMessage']).toBe('runtime already has an active run')
    expect(request['body']).toBe('line 1\nline 2\nline 3\n')
  })

  it('preserves the failed dm --json envelope shape when the target runtime is busy', async () => {
    await seedBusyRuntime()

    const result = await runDmJson('cody@agent-spaces:T-01303', 'line 1\nline 2\nline 3\n')
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')

    const envelope = JSON.parse(result.stdout) as Record<string, unknown>
    expect(Object.hasOwn(envelope, 'messageId')).toBe(true)
    expect(Object.hasOwn(envelope, 'seq')).toBe(true)
    expect(Object.hasOwn(envelope, 'to')).toBe(true)
    expect(Object.hasOwn(envelope, 'sessionRef')).toBe(true)
    expect(Object.hasOwn(envelope, 'request')).toBe(true)

    const request = envelope['request'] as Record<string, unknown>
    const execution = request['execution'] as Record<string, unknown>
    expect(execution['state']).toBe('failed')
    expect(execution['errorMessage']).toBeString()
    expect((execution['errorMessage'] as string).length).toBeGreaterThan(0)
  })
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function seedBusyRuntime(): Promise<void> {
  const scopeRef = 'agent:cody:project:agent-spaces:task:T-01303'
  const hostSessionId = 'hsid-busy-dm-json'
  const runtimeId = 'rt-busy-dm-json'
  const runId = 'run-busy-dm-json'
  const now = fixture.now()
  fixture.seedSession(hostSessionId, scopeRef)

  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'busy',
      activeRunId: runId,
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    db.runs.insert({
      runId,
      hostSessionId,
      runtimeId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      status: 'running',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }

  await mkdir(join(fixture.tmpDir, 'agents', 'cody'), { recursive: true })
}

async function runDmJson(
  target: string,
  body: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ['bun', HRCCHAT_MAIN, 'dm', '--json', target, '-'],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ASP_AGENTS_ROOT: join(fixture.tmpDir, 'agents'),
      ASP_PROJECT: 'agent-spaces',
      HRC_RUNTIME_DIR: fixture.runtimeRoot,
      HRC_STATE_DIR: fixture.stateRoot,
    },
  })
  proc.stdin.write(body)
  proc.stdin.end()

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { exitCode, stdout, stderr }
}

async function expectJqParses(input: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['jq', '-e', '.'],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.write(input)
  proc.stdin.end()

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  expect({ exitCode, stdout, stderr }).toMatchObject({
    exitCode: 0,
    stderr: '',
  })
}
