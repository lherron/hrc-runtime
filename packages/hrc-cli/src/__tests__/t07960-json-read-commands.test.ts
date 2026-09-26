/**
 * T-07960: root `--output json` must reach the declared finite read surfaces.
 *
 * These tests exercise Commander registration and the actual CLI entry point
 * against a temporary HRC daemon. They intentionally do not import the
 * renderer implementations under test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { Command } from 'commander'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcTestFixture } from '../../../hrc-server/src/__tests__/fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from '../../../hrc-server/src/__tests__/fixtures/hrc-test-fixture'
import { createHrcServer } from '../../../hrc-server/src/index'
import type { HrcServer } from '../../../hrc-server/src/index'
import { buildProgram } from '../cli/build-program'
import { runCli } from './fixtures/cli.fixture'

const RUNTIME_ID = 'rt-t07960-read'
const HOST_SESSION_ID = 'hs-t07960-read'
const RUN_ID = 'run-t07960-read'
const INVOCATION_ID = 'inv-t07960-read'
const SCOPE_REF = 'agent:json-reader:project:hrc-runtime:task:T-07960'
const CREATED_AT = new Date().toISOString()
const FINAL_SUMMARY = {
  reason: 'prompt_input_exit',
  summary: {
    invocationId: INVOCATION_ID,
    state: 'ready',
    driver: 'codex-app-server',
    startedAt: CREATED_AT,
    lastActivityAt: CREATED_AT,
    turnsCompleted: 2,
  },
}

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

function cliEnv(): Record<string, string> {
  return {
    HRC_RUNTIME_DIR: fixture.runtimeRoot,
    HRC_STATE_DIR: fixture.stateRoot,
  }
}

function commandAt(program: Command, path: string[]): Command {
  let current = program
  for (const name of path) {
    const next = current.commands.find((candidate) => candidate.name() === name)
    if (!next) throw new Error(`missing command: ${path.join(' ')}`)
    current = next
  }
  return current
}

function seedReadRuntime(): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.insert({
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: `op-${RUNTIME_ID}`,
      lastActivityAt: CREATED_AT,
      runtimeStateJson: { finalSummary: FINAL_SUMMARY },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    db.runs.insert({
      runId: RUN_ID,
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      status: 'completed',
      acceptedAt: CREATED_AT,
      completedAt: CREATED_AT,
      updatedAt: CREATED_AT,
      operationId: `op-${RUNTIME_ID}`,
      invocationId: INVOCATION_ID,
    })
    db.brokerInvocations.insert({
      invocationId: INVOCATION_ID,
      operationId: `op-${RUNTIME_ID}`,
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      brokerProtocol: 'harness-broker/0.1',
      brokerDriver: 'codex-app-server',
      invocationState: 'terminated',
      capabilitiesJson: JSON.stringify({ turns: 'multi' }),
      specHash: 'sha256:t07960-spec',
      startRequestHash: 'sha256:t07960-request',
      selectedProfileHash: 'sha256:t07960-profile',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    db.brokerInvocationEvents.appendEvent({
      invocationId: INVOCATION_ID,
      seq: 1,
      time: CREATED_AT,
      type: 'assistant.message.completed',
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      payload: { content: [{ type: 'text', text: 'raw transcript payload' }] },
      envelopeJson: JSON.stringify({
        invocationId: INVOCATION_ID,
        seq: 1,
        time: CREATED_AT,
        type: 'assistant.message.completed',
        payload: { content: [{ type: 'text', text: 'raw transcript payload' }] },
      }),
    })
  } finally {
    db.close()
  }
}

function refreshReadRuntime(): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.runtimes.update(RUNTIME_ID, { status: 'ready', updatedAt: new Date().toISOString() })
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07960-json-')
  seedReadRuntime()
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

describe('T-07960 finite read JSON command contract', () => {
  it('declares --json on the selected Commander leaves', () => {
    const program = buildProgram()
    for (const path of [
      ['monitor', 'transcript'],
      ['monitor', 'session-report'],
      ['session', 'resolve'],
      ['session', 'get'],
      ['admin', 'surface', 'list'],
      ['admin', 'bridge', 'list'],
      ['ls'],
    ]) {
      expect(commandAt(program, path).options.some((option) => option.long === '--json')).toBe(true)
    }
  })

  it('renders selected reads through --output json as JSON data', async () => {
    // Startup reconciliation correctly fences the synthetic broker lease. The
    // list endpoints require an available runtime, so make its test-only lease
    // current immediately before exercising the read contracts.
    refreshReadRuntime()

    const surfaces = await runCli(
      ['admin', 'surface', 'list', RUNTIME_ID, '--output', 'json'],
      cliEnv()
    )
    expect(surfaces.exitCode).toBe(0)
    expect(JSON.parse(surfaces.stdout)).toEqual([])

    const bridges = await runCli(
      ['admin', 'bridge', 'list', RUNTIME_ID, '--output', 'json'],
      cliEnv()
    )
    expect(bridges.stderr).toBe('')
    expect(bridges.exitCode).toBe(0)
    expect(JSON.parse(bridges.stdout)).toEqual([])

    const transcript = await runCli(
      ['monitor', 'transcript', RUNTIME_ID, '--output', 'json'],
      cliEnv()
    )
    expect(transcript.exitCode).toBe(0)
    const transcriptBody = JSON.parse(transcript.stdout) as Array<Record<string, unknown>>
    expect(transcriptBody).toHaveLength(1)
    expect(transcriptBody[0]).toMatchObject({
      seq: 1,
      type: 'assistant.message.completed',
      payload: { content: [{ type: 'text', text: 'raw transcript payload' }] },
    })

    const report = await runCli(
      [
        'monitor',
        'session-report',
        '--runtime',
        RUNTIME_ID,
        '--scope',
        'json-report-scope',
        '--output',
        'json',
      ],
      cliEnv()
    )
    expect(report.exitCode).toBe(0)
    expect(JSON.parse(report.stdout)).toMatchObject({
      target: RUNTIME_ID,
      runtimeId: RUNTIME_ID,
      scopeLabel: 'json-report-scope',
      finalSummary: FINAL_SUMMARY,
    })

    const resolve = await runCli(
      ['session', 'resolve', '--scope', SCOPE_REF, '--output', 'json'],
      cliEnv()
    )
    expect(resolve.exitCode).toBe(0)
    expect(JSON.parse(resolve.stdout)).toMatchObject({ found: false, hostSessionId: null })

    const get = await runCli(['session', 'get', HOST_SESSION_ID, '--output', 'json'], cliEnv())
    expect(get.exitCode).toBe(0)
    expect(JSON.parse(get.stdout)).toMatchObject({ hostSessionId: HOST_SESSION_ID })

    const ls = await runCli(['ls', 'runtimes', '--output', 'json'], cliEnv())
    expect(ls.exitCode).toBe(0)
    expect(JSON.parse(ls.stdout)).toEqual([expect.objectContaining({ runtimeId: RUNTIME_ID })])
  })

  it('advertises the forwarded ls JSON flag', async () => {
    const result = await runCli(['ls', '--help'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--json')
  })
})
