import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createHrcServer } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  cliEnv,
  dbPath,
  runCli,
  serverOpts,
  setServer,
  setupCliFixture,
  teardownCliFixture,
} from './fixtures/cli.fixture'

/**
 * T-08385 CLI contract: one reviewed run ID flows through the explicit
 * recover-unstarted command and emits the daemon's structured result. The
 * explicit dry-run is required in this non-TTY test process by the shared
 * mutation gate.
 */
const RUNTIME_ID = 'rt-t08385-cli'
const HOST_SESSION_ID = 'hsid-t08385-cli'
const SCOPE_REF = 'agent:t08385-cli'
const OPERATION_ID = 'op-t08385-cli'
const INVOCATION_ID = 'inv-t08385-cli'
const RUN_ID = 'run-t08385-cli'
const SUBMISSION_ID = 'submission-t08385-cli'

function seedCandidate(): void {
  const db = openHrcDatabase(dbPath)
  const old = new Date(Date.now() - 15 * 60_000).toISOString()
  try {
    db.sessions.insert({
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: 1,
      status: 'active',
      createdAt: old,
      updatedAt: old,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'codex',
      status: 'busy',
      controllerKind: 'harness-broker',
      activeRunId: RUN_ID,
      activeOperationId: OPERATION_ID,
      activeInvocationId: INVOCATION_ID,
      lastActivityAt: old,
      supportsInflightInput: false,
      adopted: false,
      createdAt: old,
      updatedAt: old,
    })
    db.brokerInvocations.insert({
      invocationId: INVOCATION_ID,
      operationId: OPERATION_ID,
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'ready',
      capabilitiesJson: '{}',
      specHash: 'sha256:spec-t08385-cli',
      startRequestHash: 'sha256:req-t08385-cli',
      selectedProfileHash: 'sha256:profile-t08385-cli',
      createdAt: old,
      updatedAt: old,
    })
    db.runs.insert({
      runId: RUN_ID,
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: old,
      updatedAt: old,
      operationId: OPERATION_ID,
      invocationId: INVOCATION_ID,
      dispatchedInputId: SUBMISSION_ID,
      brokerSubmissionId: SUBMISSION_ID,
    })
  } finally {
    db.close()
  }
}

beforeEach(setupCliFixture)
afterEach(teardownCliFixture)

describe('hrc admin runs recover-unstarted', () => {
  it('passes one runId through as a JSON dry-run result', async () => {
    const server = await createHrcServer(serverOpts())
    setServer(server)
    ;(server as any).getHarnessBrokerController = () => ({
      seatProbe: async () => ({
        ok: true,
        response: {
          invocationId: INVOCATION_ID,
          seat: { state: 'idle' },
          brokerHeldDepth: 0,
        },
      }),
    })
    seedCandidate()

    const result = await runCli(
      ['admin', 'runs', 'recover-unstarted', RUN_ID, '--dry-run', '--json'],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      runId: RUN_ID,
      runtimeId: RUNTIME_ID,
      status: 'matched',
    })
  })
})
