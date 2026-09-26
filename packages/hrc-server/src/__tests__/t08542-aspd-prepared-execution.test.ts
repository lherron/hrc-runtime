/**
 * T-08542 — HRC-hosted headless codex-app-server preparation through aspd with a
 * frozen execution release (hrc-runtime.aspd-prepared-execution-release).
 *
 * Real pieces: a Unix-socket aspd double speaking the published ASPC NDJSON wire
 * through the real `AspcUnixClient`, the real HRC server handlers, the real
 * `HarnessBrokerController`, and the real durable headless substrate allocator.
 * Doubles: the tmux manager (records the exact broker command it would exec) and
 * the worker's broker client, whose hello reports the release of the executable
 * the allocator actually launched — so a worker's identity follows its launch,
 * not a value the test hands the assertion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { renameSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  validateFrozenExecutionRelease,
  workerHelloRefusal,
} from '../agent-spaces-adapter/aspd-execution-release'
import {
  admitAspdHello,
  prepareThroughAspd,
  projectAspdServiceStatus,
} from '../agent-spaces-adapter/aspd-preparation-client'
import { launchAspdPreparedAttempt, readAspdPreparation } from '../aspd-headless-start'
import { createBrokerDurableHeadlessAllocator } from '../broker-interactive-handlers/substrate-allocator'
import { HarnessBrokerController } from '../broker/controller'
import { persistedAspdExecutionRelease } from '../broker/controller/dispatch'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import {
  type AspdDouble,
  type HostingLedger,
  type Release,
  executionReleaseOf,
  makeRelease,
  startAspdDouble,
  tmuxManagerDouble,
  workerClient,
} from './fixtures/aspd-route-doubles'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE = 'agent:t08542:project:hrc-runtime:task:T-08542'

// ── Harness ───────────────────────────────────────────────────────────────────

let fixture: HrcServerTestFixture
let server: HrcServer
let scratch: string
let aspdSocket: string
let aspd: AspdDouble
let releaseA: Release
let releaseB: Release
let ledger: HostingLedger
const savedEnv: Record<string, string | undefined> = {}

type Internal = {
  db: HrcDatabase
  options: { runtimeRoot: string }
  harnessBrokerController?: HarnessBrokerController
  startHeadlessBrokerRuntime(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string | undefined,
    options?: Record<string, unknown>
  ): Promise<HrcRuntimeSnapshot>
  handleHeadlessBrokerDispatchTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string | undefined,
    options?: Record<string, unknown>
  ): Promise<Response>
  executeHeadlessBrokerStartTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string,
    options: Record<string, unknown>
  ): Promise<Response>
}

function internal(): Internal {
  return server as unknown as Internal
}

function headlessIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', id: 'codex-cli', interactive: false },
    execution: { preferredMode: 'headless' },
  } as HrcRuntimeIntent
}

async function session(scope = SCOPE): Promise<HrcSessionRecord> {
  const resolved = await fixture.resolveSession(scope)
  const record = internal().db.sessions.getByHostSessionId(resolved.hostSessionId)
  if (record === null) throw new Error('session missing')
  return record
}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** (Re)create the server under test with the doubled worker controller. */
async function bootServer(overrides: { codexCliTmuxBrokerEnabled?: boolean } = {}): Promise<void> {
  server = await createHrcServer(
    fixture.serverOpts({
      headlessCodexBrokerEnabled: true,
      codexCliTmuxBrokerEnabled: overrides.codexCliTmuxBrokerEnabled ?? false,
      otelListenerEnabled: false,
    })
  )
  const releases = [releaseA, releaseB]
  const tmuxManagerFactory = tmuxManagerDouble(ledger)
  internal().harnessBrokerController = new HarnessBrokerController({
    db: internal().db,
    brokerUnixClientFactory: async () =>
      workerClient(ledger, releases, ledger.commands.at(-1)) as never,
    headlessSubstrateAllocator: createBrokerDurableHeadlessAllocator(internal().options, {
      tmuxManagerFactory: tmuxManagerFactory as never,
      generateAttachToken: () => 'attach-token-t08542',
    }),
    now: () => new Date().toISOString(),
  } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08542-')
  scratch = await mkdtemp(join(tmpdir(), 't8542-'))
  releaseA = makeRelease(join(scratch, 'releases'), 'a')
  releaseB = makeRelease(join(scratch, 'releases'), 'b')
  aspdSocket = join(scratch, 'aspd.sock')
  aspd = startAspdDouble(aspdSocket, releaseA)
  setEnv('HRC_ASPD_SOCKET', aspdSocket)
  // A resolver-governed selection that would be wrong if this route consulted it.
  setEnv('HRC_HARNESS_BROKER_CMD', '/nonexistent/resolver-selected-harness-broker')

  ledger = { commands: [], killedServers: [], startCalls: [], submissionCalls: [], attachCalls: 0 }
  await bootServer()
})

afterEach(async () => {
  aspd.stop()
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    delete savedEnv[name]
  }
  await server.stop()
  await fixture.cleanup()
  await rm(scratch, { recursive: true, force: true })
})

function operationsFor(hostSessionId: string) {
  return internal()
    .db.sqlite.query<{ operation_id: string; status: string; error_code: string | null }, [string]>(
      `SELECT operation_id, status, error_code FROM runtime_operations
        WHERE host_session_id = ? ORDER BY created_at ASC`
    )
    .all(hostSessionId)
}

// ── Pure release binding ──────────────────────────────────────────────────────

describe('T-08542 release binding from persisted bytes', () => {
  it('accepts the frozen release and names each refusal', () => {
    expect(validateFrozenExecutionRelease(executionReleaseOf(releaseA)).executable).toContain(
      releaseA.releaseId
    )
    expect(() => validateFrozenExecutionRelease(undefined)).toThrow('no executionRelease')
    expect(() =>
      validateFrozenExecutionRelease({ ...executionReleaseOf(releaseA), sourceCommit: 'x' })
    ).toThrow('does not match')
    expect(() =>
      validateFrozenExecutionRelease({
        ...executionReleaseOf(releaseA),
        worker: { ...executionReleaseOf(releaseA).worker, executable: '/bin/sh' },
      })
    ).toThrow('does not resolve inside')
    expect(() =>
      validateFrozenExecutionRelease({
        ...executionReleaseOf(releaseA),
        worker: {
          ...executionReleaseOf(releaseA).worker,
          protocol: 'harness-broker/0.3',
        },
      })
    ).toThrow('does not support worker protocol')
    renameSync(releaseA.releaseRoot, `${releaseA.releaseRoot}.withheld`)
    try {
      validateFrozenExecutionRelease(executionReleaseOf(releaseA))
      throw new Error('expected refusal')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('release_unavailable')
    }
  })

  it('refuses a worker hello that is not the frozen release', () => {
    const frozen = executionReleaseOf(releaseA)
    expect(
      workerHelloRefusal(frozen, {
        protocolVersion: 'harness-broker/0.2',
        release: {
          releaseId: releaseA.releaseId,
          sourceCommit: releaseA.sourceCommit,
          builtAt: releaseA.builtAt,
        },
      })
    ).toBeUndefined()
    expect(
      workerHelloRefusal(frozen, {
        protocolVersion: 'harness-broker/0.2',
        release: {
          releaseId: releaseB.releaseId,
          sourceCommit: releaseB.sourceCommit,
          builtAt: releaseB.builtAt,
        },
      })?.code
    ).toBe('worker_release_mismatch')
    expect(workerHelloRefusal(frozen, { protocolVersion: 'harness-broker/0.2' })?.code).toBe(
      'worker_release_unidentified'
    )
    expect(
      workerHelloRefusal(frozen, { protocolVersion: 'harness-broker/0.3', release: undefined })
        ?.code
    ).toBe('worker_protocol_mismatch')
  })
})

// ── Preparation client ────────────────────────────────────────────────────────

describe('T-08542 aspd preparation client', () => {
  it('names service incompatibility and never admits a cohosted/stdio-only or unidentified service', () => {
    const base = {
      facadeInfo: { name: 'aspc-facade', version: 'x' },
      protocolVersion: 'aspc/0.1',
      capabilities: { compileHarnessInvocation: true, transports: ['unix-jsonrpc-ndjson'] },
      release: { releaseId: 'r', sourceCommit: 'c', builtAt: 'b' },
    } as never
    expect(admitAspdHello('/s', base).release.releaseId).toBe('r')
    const code = (hello: unknown) => {
      try {
        admitAspdHello('/s', hello as never)
        return 'admitted'
      } catch (error) {
        return (error as { detail?: { code?: string } }).detail?.code
      }
    }
    expect(code({ ...(base as object), protocolVersion: 'aspc/0.2' })).toBe(
      'aspd_protocol_incompatible'
    )
    expect(
      code({
        ...(base as object),
        capabilities: { compileHarnessInvocation: true, transports: ['stdio-jsonrpc-ndjson'] },
      })
    ).toBe('aspd_capability_missing')
    expect(code({ ...(base as object), release: undefined })).toBe('aspd_release_unidentified')
  })

  it('reports an absent endpoint as aspd_unavailable and closes every connection it opens', async () => {
    await expect(
      prepareThroughAspd(join(scratch, 'absent.sock'), {} as never)
    ).rejects.toMatchObject({ detail: { code: 'aspd_unavailable' } })

    const status = await projectAspdServiceStatus({ HRC_ASPD_SOCKET: aspdSocket })
    expect(status).toMatchObject({
      configured: true,
      reachable: true,
      release: { releaseId: releaseA.releaseId },
    })
    await Bun.sleep(20)
    expect(aspd.openConnections).toBe(0)
    expect(await projectAspdServiceStatus({})).toEqual({ configured: false })
  })
})

// ── Server route ──────────────────────────────────────────────────────────────

describe('T-08542 configured route: prepare, freeze, launch', () => {
  it('commits boundary P before any hosting effect and launches only the frozen release', async () => {
    const s = await session()
    let statusAtFirstEffect: string | undefined
    ledger.onFirstHostingEffect = () => {
      statusAtFirstEffect = operationsFor(s.hostSessionId)[0]?.status
    }

    const runtime = await internal().startHeadlessBrokerRuntime(
      s,
      headlessIntent(),
      'hello',
      'run-t08542-cold'
    )

    expect(statusAtFirstEffect).toBe('prepared')
    expect(aspd.compileCalls).toBe(1)
    expect(ledger.commands).toHaveLength(1)
    expect(ledger.commands[0]).toContain(join(releaseA.releaseRoot, 'harness-broker'))
    expect(ledger.commands[0]).not.toContain('resolver-selected')
    expect(ledger.startCalls).toHaveLength(1)

    const [operation] = operationsFor(s.hostSessionId)
    expect(operation?.status).toBe('completed')
    const { record } = readAspdPreparation(internal(), operation!.operation_id)
    expect(record.executionRelease.releaseId).toBe(releaseA.releaseId)
    expect(record.aspd.release.releaseId).toBe(releaseA.releaseId)
    expect(record.admission.execution.dispatchRequest.startRequest).toEqual(
      ledger.startCalls[0]!.request
    )
    const persisted = persistedAspdExecutionRelease(
      internal().db.runtimes.getByRuntimeId(runtime.runtimeId)!
    )
    expect(persisted?.releaseId).toBe(releaseA.releaseId)
    await Bun.sleep(20)
    expect(aspd.openConnections).toBe(0)
  })

  it('T-08207 freezes a format-2 no-run preparation and launches its observed-execution invocation', async () => {
    const s = await session()
    const runtime = await internal().startHeadlessBrokerRuntime(
      s,
      headlessIntent(),
      'format-2 initial input',
      undefined,
      {
        executionFormat: 'format2',
        dispatchIdempotencyKey: 't08207-format2-start',
        format2RequestHash: 'sha256:t08207-format2-start',
      }
    )

    const [operation] = operationsFor(s.hostSessionId)
    const { record } = readAspdPreparation(internal(), operation!.operation_id)
    const invocation = internal().db.brokerInvocations.getByInvocationId(
      String(record.admission.identity.invocationId)
    )
    expect(record.runId).toBeUndefined()
    expect(record.admission.executionFormat).toBe('format2')
    expect(record.admission.identity.initialInputId).toMatch(/^input-/)
    expect(record.admission.identity.runId).toBeUndefined()
    expect(operation?.run_id).toBeUndefined()
    expect(runtime.activeRunId).toBeUndefined()
    expect(invocation).toMatchObject({ executionFormat: 'format2' })
    expect(invocation?.runId).toBeUndefined()
    expect(ledger.startCalls[0]?.request.spec.correlation).not.toHaveProperty('runId')
  })

  it('T-08207 admits one protected format-2 input before broker start, then replays its exact key without a second body', async () => {
    const s = await session()
    const idempotencyKey = 't08207-format2-admission-key'
    const requestHash = 'sha256:t08207-format2-admission'
    let observedInputId: string | undefined
    let resolveBeforeBrokerWrite: (() => void) | undefined
    const beforeBrokerWrite = new Promise<void>((resolve) => {
      resolveBeforeBrokerWrite = resolve
    })

    ledger.onBeforeStartInvocation = (request) => {
      observedInputId = request.initialInput?.inputId
      resolveBeforeBrokerWrite?.()
    }

    const first = await internal().handleHeadlessBrokerDispatchTurn(
      s,
      headlessIntent(),
      'first format-2 input',
      undefined,
      {
        executionFormat: 'format2',
        dispatchIdempotencyKey: idempotencyKey,
        format2RequestHash: requestHash,
        submissionDoor: 'invoke',
        waitForCompletion: false,
      }
    )
    const firstBody = (await first.json()) as {
      inputId: string
      runtimeId: string
      observation: { broker: { selector: { invocationId: string }; afterSeq: number } }
    }
    expect(firstBody).toMatchObject({
      inputId: observedInputId,
      hostSessionId: s.hostSessionId,
      transport: 'headless',
      executionFormat: 'format2',
      status: 'accepted',
      supportsInFlightInput: false,
      startIdentity: { kind: 'broker' },
    })
    await beforeBrokerWrite
    expect(observedInputId).toMatch(/^input-/)
    const admitted = internal().db.inputs.getByInputId(observedInputId!)
    expect(admitted).toMatchObject({
      inputId: observedInputId,
      admissionHostSessionId: s.hostSessionId,
      idempotencyKey,
      requestHash,
      runtimeId: expect.any(String),
      operationId: expect.any(String),
      invocationId: expect.any(String),
      status: 'accepted',
      cleanupProtection: 'protected',
    })
    expect(internal().db.runs.listByRuntimeId(admitted!.runtimeId!)).toHaveLength(0)
    expect(
      internal().db.sqlite
        .query<{ count: number }, [string]>(
          'SELECT count(*) AS count FROM submission_admissions WHERE run_id IS NOT NULL AND runtime_id = ?'
        )
        .get(admitted!.runtimeId!)?.count
    ).toBe(0)
    const admittedEvents = internal().db.sqlite
      .query<{ hrc_seq: number; runtime_id: string | null; event_kind: string; payload_json: string }, []>(
        'SELECT hrc_seq, runtime_id, event_kind, payload_json FROM hrc_events ORDER BY hrc_seq'
      )
      .all()
    expect(
      admittedEvents.filter((event) => event.event_kind === 'input.admitted')
    ).toEqual([
      expect.objectContaining({ runtime_id: admitted!.runtimeId }),
    ])
    expect(ledger.startCalls).toHaveLength(1)

    // A lost response can replay after native carrier/terminal evidence has
    // reached the raw ledger. The receipt must retain its exclusive admission
    // fence, so a consumer can still watch those rows rather than starting
    // after them.
    // Reload after the matcher above: Bun's asymmetric matcher mutates its
    // received object, while these are the real durable placement coordinates.
    const admittedPlacement = internal().db.inputs.getByInputId(observedInputId!)!
    const invocationId = admittedPlacement.invocationId!
    const runtimeId = admittedPlacement.runtimeId!
    const admissionAfterSeq = firstBody.observation.broker.afterSeq
    expect(firstBody.observation.broker.selector.invocationId).toBe(invocationId)
    expect(firstBody.runtimeId).toBe(runtimeId)
    const postAdmissionStart = {
      invocationId,
      seq: admissionAfterSeq + 1,
      time: '2026-09-26T09:41:00.000Z',
      type: 'turn.started',
      runtimeId,
      payload: { turnId: 'turn-t08207-replay-fence' },
    }
    internal().db.brokerInvocationEvents.appendEvent(postAdmissionStart)
    internal().db.brokerInvocationEvents.appendEvent({
      invocationId,
      seq: admissionAfterSeq + 2,
      time: '2026-09-26T09:41:01.000Z',
      type: 'turn.completed',
      runtimeId,
      payload: { turnId: 'turn-t08207-replay-fence', success: true },
    })
    expect(
      internal().db.brokerInvocationEvents.maxBrokerSeq(invocationId)
    ).toBe(admissionAfterSeq + 2)

    const replay = await internal().handleHeadlessBrokerDispatchTurn(
      s,
      headlessIntent(),
      'first format-2 input',
      undefined,
      {
        executionFormat: 'format2',
        dispatchIdempotencyKey: idempotencyKey,
        format2RequestHash: requestHash,
        submissionDoor: 'invoke',
        waitForCompletion: false,
      }
    )
    expect(await replay.json()).toMatchObject({
      inputId: observedInputId,
      executionFormat: 'format2',
      status: 'accepted',
      observation: { broker: { afterSeq: admissionAfterSeq } },
    })
    expect(ledger.startCalls).toHaveLength(1)
  })

  it('T-08207 protects and binds a warm format-2 body before one native broker submission', async () => {
    const s = await session()
    await internal().handleHeadlessBrokerDispatchTurn(
      s,
      headlessIntent(),
      'format-2 launch input',
      undefined,
      {
        executionFormat: 'format2',
        dispatchIdempotencyKey: 't08207-format2-warm-bootstrap',
        format2RequestHash: 'sha256:t08207-format2-warm-bootstrap',
        submissionDoor: 'invoke',
      }
    )

    // The initial receipt is intentionally early (before the broker write).
    // Let the real controller publish its active broker binding, then exercise
    // the warm class door through that binding.
    await Bun.sleep(20)
    const first = await internal().handleHeadlessBrokerDispatchTurn(
      s,
      headlessIntent(),
      'format-2 warm body',
      undefined,
      {
        executionFormat: 'format2',
        dispatchIdempotencyKey: 't08207-format2-warm-body',
        format2RequestHash: 'sha256:t08207-format2-warm-body',
        submissionDoor: 'invoke',
      }
    )
    const firstBody = (await first.json()) as { inputId: string; runtimeId: string; status: string }
    const admitted = internal().db.inputs.getByInputId(firstBody.inputId)
    expect(admitted).toMatchObject({
      idempotencyKey: 't08207-format2-warm-body',
      runtimeId: firstBody.runtimeId,
      brokerSubmissionId: 'submission-warm-1',
      cleanupProtection: 'protected',
      status: 'accepted',
    })
    expect(ledger.submissionCalls).toEqual([
      expect.objectContaining({ body: 'format-2 warm body' }),
    ])
    expect(internal().db.runs.listByRuntimeId(firstBody.runtimeId)).toHaveLength(0)
    expect(
      internal().db.sqlite
        .query<{ count: number }, [string]>(
          'SELECT count(*) AS count FROM submission_admissions WHERE run_id IS NOT NULL AND runtime_id = ?'
        )
        .get(firstBody.runtimeId)?.count
    ).toBe(0)

    const replay = await internal().handleHeadlessBrokerDispatchTurn(
      s,
      headlessIntent(),
      'format-2 warm body',
      undefined,
      {
        executionFormat: 'format2',
        dispatchIdempotencyKey: 't08207-format2-warm-body',
        format2RequestHash: 'sha256:t08207-format2-warm-body',
        submissionDoor: 'invoke',
      }
    )
    expect((await replay.json()) as { inputId: string }).toMatchObject({ inputId: firstBody.inputId })
    expect(ledger.submissionCalls).toHaveLength(1)
  })

  it('T-08207 keeps a format-2 input protected when the broker start rejects after reservation', async () => {
    const s = await session()
    ledger.startThrows = new Error('controlled broker start refusal')
    const response = await internal().handleHeadlessBrokerDispatchTurn(
      s,
      headlessIntent(),
      'possibly-written format-2 input',
      undefined,
      {
        executionFormat: 'format2',
        dispatchIdempotencyKey: 't08207-format2-error-key',
        format2RequestHash: 'sha256:t08207-format2-error',
        submissionDoor: 'invoke',
        waitForCompletion: false,
      }
    )
    expect((await response.json()) as { status: string }).toMatchObject({ status: 'accepted' })
    await Bun.sleep(0)
    const [input] = internal().db.inputs.listProtectedByRuntimeId(
      internal().db.runtimes.listByHostSessionId(s.hostSessionId)[0]!.runtimeId
    )
    expect(input).toMatchObject({
      idempotencyKey: 't08207-format2-error-key',
      cleanupProtection: 'protected',
      status: 'accepted',
    })
  })

  it('T-08207 rejects a same-key retry whose frozen format differs before another compile or launch', async () => {
    const s = await session()
    const key = 't08207-format-freeze'
    const withheld = `${releaseA.releaseRoot}.t08207-withheld`
    renameSync(releaseA.releaseRoot, withheld)
    await expect(
      internal().startHeadlessBrokerRuntime(s, headlessIntent(), 'input', undefined, {
        executionFormat: 'format2',
        dispatchIdempotencyKey: key,
      })
    ).rejects.toMatchObject({ detail: { code: 'release_unavailable' } })
    const compilesBeforeMismatch = aspd.compileCalls
    await expect(
      internal().startHeadlessBrokerRuntime(s, headlessIntent(), 'input', 'run-t08207-f1', {
        executionFormat: 'format1',
        dispatchIdempotencyKey: key,
      })
    ).rejects.toMatchObject({ detail: { code: 'execution_format_mismatch' } })
    expect(aspd.compileCalls).toBe(compilesBeforeMismatch)
    expect(ledger.commands).toHaveLength(0)
    renameSync(withheld, releaseA.releaseRoot)
  })

  it('returns the cold launch initial-input admission identity to an injector door', async () => {
    const s = await session()
    const response = await internal().executeHeadlessBrokerStartTurn(
      s,
      headlessIntent(),
      'injector envelope body',
      'run-t08542-injector',
      {
        waitForCompletion: false,
        submissionDoor: 'invoke',
        submissionOrigin: { principalRef: 'agent:test', envelopeId: 'EN-T08542' },
      }
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { submissionId?: string; admission?: string }
    const [operation] = operationsFor(s.hostSessionId)
    const { record } = readAspdPreparation(internal(), operation!.operation_id)
    const inputId = record.admission.execution.dispatchRequest.startRequest.initialInput!.inputId
    expect(body).toEqual({
      runId: 'run-t08542-injector',
      hostSessionId: s.hostSessionId,
      generation: s.generation,
      runtimeId: expect.any(String),
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
      submissionId: inputId,
      admission: 'admitted',
    })
    const admission = internal()
      .db.sqlite.query<
        { submission_id: string; door: string; envelope_id: string | null },
        [string]
      >('SELECT submission_id, door, envelope_id FROM submission_admissions WHERE run_id = ?')
      .get('run-t08542-injector')
    expect(admission).toEqual({ submission_id: inputId, door: 'invoke', envelope_id: 'EN-T08542' })
  })

  it('refuses without fallback when aspd is unavailable, incompatible, or omits executionRelease', async () => {
    const s = await session()
    aspd.stop()
    await expect(
      internal().startHeadlessBrokerRuntime(s, headlessIntent(), 'x', 'run-t08542-down')
    ).rejects.toMatchObject({ detail: { code: 'aspd_unavailable' } })

    aspd = startAspdDouble(aspdSocket, releaseA)
    aspd.helloOverride = { protocolVersion: 'aspc/0.9' }
    await expect(
      internal().startHeadlessBrokerRuntime(s, headlessIntent(), 'x', 'run-t08542-incompat')
    ).rejects.toMatchObject({ detail: { code: 'aspd_protocol_incompatible' } })

    aspd.helloOverride = undefined
    aspd.omitExecutionRelease = true
    await expect(
      internal().startHeadlessBrokerRuntime(s, headlessIntent(), 'x', 'run-t08542-norelease')
    ).rejects.toMatchObject({ detail: { code: 'execution_release_missing' } })

    expect(ledger.commands).toHaveLength(0)
    expect(operationsFor(s.hostSessionId)).toHaveLength(0)
  })

  it('keeps a never-submitted A preparation bound to A across B activation and resumes it only by same-key retry', async () => {
    const s = await session()
    const key = 'retry-key-t08542'
    const intent = headlessIntent()
    // aspd resolved its serving release at startup, so withholding A's directory
    // from HRC does not stop preparation: P commits, then HRC's pre-launch
    // validation of the persisted bytes refuses.
    const withheld = `${releaseA.releaseRoot}.withheld`
    renameSync(releaseA.releaseRoot, withheld)
    await expect(
      internal().startHeadlessBrokerRuntime(s, intent, 'frozen', 'run-t08542-frozen', {
        dispatchIdempotencyKey: key,
      })
    ).rejects.toMatchObject({ detail: { code: 'release_unavailable' } })
    expect(aspd.compileCalls).toBe(1)
    const [prepared] = operationsFor(s.hostSessionId)
    expect(prepared).toMatchObject({ status: 'prepared', error_code: 'release_unavailable' })
    expect(
      readAspdPreparation(internal(), prepared!.operation_id).record.executionRelease.releaseId
    ).toBe(releaseA.releaseId)
    expect(ledger.commands).toHaveLength(0)

    // A retry with a different key is a new request: it never adopts the frozen attempt.
    await expect(
      internal().startHeadlessBrokerRuntime(s, intent, 'other', 'run-t08542-otherkey', {
        dispatchIdempotencyKey: 'a-different-key',
      })
    ).rejects.toMatchObject({ detail: { code: 'release_unavailable' } })
    expect(aspd.compileCalls).toBe(2)
    expect(operationsFor(s.hostSessionId)).toHaveLength(2)
    // Activate B at the same endpoint, restore A.
    aspd.serving = releaseB
    renameSync(withheld, releaseA.releaseRoot)
    const beforeRetry = aspd.compileCalls
    await internal().startHeadlessBrokerRuntime(s, intent, 'frozen', 'run-t08542-frozen', {
      dispatchIdempotencyKey: key,
    })
    expect(aspd.compileCalls).toBe(beforeRetry)
    expect(ledger.commands.at(-1)).toContain(releaseA.releaseRoot)
    const frozenRow = operationsFor(s.hostSessionId).find(
      (row) => row.operation_id === prepared!.operation_id
    )
    expect(frozenRow?.status).toBe('completed')

    // A fresh scope without the key prepares on B.
    const other = await session('agent:t08542b:project:hrc-runtime:task:T-08542')
    await internal().startHeadlessBrokerRuntime(other, headlessIntent(), 'new', 'run-t08542-b')
    expect(aspd.compileCalls).toBe(beforeRetry + 1)
    expect(ledger.commands.at(-1)).toContain(releaseB.releaseRoot)
  })

  it('refuses a worker whose hello is not the frozen release before invocation.start and reclaims its lease', async () => {
    const s = await session()
    ledger.helloReleaseOverride = {
      releaseId: releaseB.releaseId,
      sourceCommit: releaseB.sourceCommit,
      builtAt: releaseB.builtAt,
    }
    await expect(
      internal().startHeadlessBrokerRuntime(s, headlessIntent(), 'x', 'run-t08542-mismatch')
    ).rejects.toMatchObject({ detail: { code: 'worker_release_mismatch' } })
    expect(ledger.startCalls).toHaveLength(0)
    expect(ledger.killedServers.length).toBeGreaterThanOrEqual(2) // pre-launch reclaim + release
    const [operation] = operationsFor(s.hostSessionId)
    expect(operation).toMatchObject({ status: 'prepared', error_code: 'worker_release_mismatch' })
    const { record } = readAspdPreparation(internal(), operation!.operation_id)
    expect(record.executionRelease.releaseId).toBe(releaseA.releaseId)
  })

  it('records an uncertain start and never makes it resumable', async () => {
    const s = await session()
    ledger.startThrows = new Error('socket closed before reply')
    await expect(
      internal().startHeadlessBrokerRuntime(s, headlessIntent(), 'x', 'run-t08542-uncertain', {
        dispatchIdempotencyKey: 'uncertain-key',
      })
    ).rejects.toBeDefined()
    const [operation] = operationsFor(s.hostSessionId)
    expect(operation?.status).not.toBe('prepared')
    const { record } = readAspdPreparation(internal(), operation!.operation_id)
    expect(record.startOutcome).toBe('uncertain')
    await expect(
      launchAspdPreparedAttempt(server as never, operation!.operation_id, {
        settleFailure: (error) => {
          throw error
        },
      })
    ).rejects.toMatchObject({ detail: { code: 'aspd_preparation_not_prepared' } })
    expect(ledger.startCalls).toHaveLength(1)
  })

  it('verifies the frozen release on the candidate reattach connection before attaching', async () => {
    const s = await session()
    const runtime = await internal().startHeadlessBrokerRuntime(
      s,
      headlessIntent(),
      'x',
      'run-t08542-reattach'
    )
    const controller = internal().harnessBrokerController!
    const mismatched = workerClient(
      {
        ...ledger,
        helloReleaseOverride: {
          releaseId: releaseB.releaseId,
          sourceCommit: releaseB.sourceCommit,
          builtAt: releaseB.builtAt,
        },
      },
      [releaseA, releaseB],
      undefined
    )
    const refused = await controller.attachAndReplay({
      runtimeId: runtime.runtimeId,
      client: mismatched as never,
      attachToken: 'attach-token-t08542',
    })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error.code).toBe('broker_reattach_release_mismatch')
    expect(ledger.attachCalls).toBe(0)
  })

  it('refuses with aspd_unconfigured when no endpoint is configured (T-08596)', async () => {
    setEnv('HRC_ASPD_SOCKET', undefined)
    const s = await session()
    const error = await internal()
      .startHeadlessBrokerRuntime(s, headlessIntent(), 'x', 'run-t08542-unconfigured')
      .then(
        () => {
          throw new Error('birth without an endpoint must refuse')
        },
        (refusal: unknown) => refusal as Error & { detail?: Record<string, unknown> }
      )
    expect(String(error.message)).toContain('aspd-independent execution closure')
    expect(error.detail).toMatchObject({ code: 'aspd_unconfigured', site: 'headless-broker-birth' })
    expect(aspd.compileCalls).toBe(0)
  })
})

describe('T-08542 pre-acceptance refusal through the public turn door', () => {
  // Found live: a blocking (waitFor terminal) cold dispatch whose boot failed
  // before acceptance left the internal acceptance promise rejected and
  // unobserved, and the daemon failed fast. Bun reports such a rejection as a
  // test failure, so each case below fails without the fix.
  it('answers a frozen-release refusal with 503 and keeps the preparation prepared', async () => {
    const s = await session()
    renameSync(releaseA.releaseRoot, `${releaseA.releaseRoot}.withheld`)
    const response = await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: 'x',
      runtimeIntent: headlessIntent(),
      idempotencyKey: 'public-door-key',
      waitFor: 'terminal',
    })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { detail: { code: string } } }
    expect(body.error.detail.code).toBe('release_unavailable')
    await Bun.sleep(20)
    expect(operationsFor(s.hostSessionId)).toMatchObject([
      { status: 'prepared', error_code: 'release_unavailable' },
    ])
  })

  it('control: the closure refusal also answers 503 without an unobserved rejection (T-08596)', async () => {
    setEnv('HRC_ASPD_SOCKET', undefined)
    const s = await session()
    const response = await fixture.postJson('/v1/turns', {
      hostSessionId: s.hostSessionId,
      prompt: 'x',
      runtimeIntent: headlessIntent(),
      idempotencyKey: 'public-door-control',
      waitFor: 'terminal',
    })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { detail: { code: string } } }
    expect(body.error.detail.code).toBe('aspd_unconfigured')
    await Bun.sleep(20)
  })
})
