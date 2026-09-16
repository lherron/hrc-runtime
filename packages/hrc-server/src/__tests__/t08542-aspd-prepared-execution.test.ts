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
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { AspcExecutionRelease } from 'spaces-aspc-protocol'
import type {
  BrokerHelloResponse,
  InvocationEventEnvelope,
  InvocationStartRequest,
  InvocationStartResponse,
} from 'spaces-harness-broker-protocol'
import type { RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import { AspcFacadeBrokerClient } from '../agent-spaces-adapter/aspc-facade-client'
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
import { makeBrokerProfile, makeCompileResponse } from './broker-compile-fixtures'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE = 'agent:t08542:project:hrc-runtime:task:T-08542'

type Release = { releaseId: string; sourceCommit: string; builtAt: string; releaseRoot: string }

// ── Release directories ───────────────────────────────────────────────────────

function makeRelease(root: string, label: string): Release {
  const releaseId = `asp-${label}-test`
  const releaseRoot = join(root, releaseId)
  mkdirSync(releaseRoot, { recursive: true })
  const release = {
    releaseId,
    sourceCommit: `${label}`.repeat(40).slice(0, 40),
    builtAt: '2026-09-16T00:00:00.000Z',
    releaseRoot,
  }
  writeFileSync(
    join(releaseRoot, 'release.json'),
    JSON.stringify({ releaseId, sourceCommit: release.sourceCommit, builtAt: release.builtAt })
  )
  writeFileSync(join(releaseRoot, 'harness-broker'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(releaseRoot, 'harness-broker'), 0o755)
  return release
}

function executionReleaseOf(release: Release): AspcExecutionRelease {
  return {
    releaseId: release.releaseId,
    sourceCommit: release.sourceCommit,
    builtAt: release.builtAt,
    releaseRoot: release.releaseRoot,
    worker: {
      protocol: 'harness-broker/0.2',
      executable: join(release.releaseRoot, 'harness-broker'),
      argvPrefix: ['run', '--transport', 'unix'],
    },
  }
}

// ── aspd double on a real Unix socket ─────────────────────────────────────────

type AspdDouble = {
  serving: Release
  compileCalls: number
  openConnections: number
  helloOverride?: Record<string, unknown> | undefined
  omitExecutionRelease?: boolean | undefined
  stop(): void
}

function startAspdDouble(socketPath: string, serving: Release): AspdDouble {
  const state: AspdDouble = {
    serving,
    compileCalls: 0,
    openConnections: 0,
    stop: () => listener.stop(true),
  }
  const buffers = new Map<unknown, string>()
  // Bun socket writes may be partial; queue the remainder until drain.
  const pending = new Map<unknown, Buffer>()
  const flush = (socket: { write(data: Buffer): number }) => {
    const queued = pending.get(socket)
    if (queued === undefined || queued.length === 0) return
    const written = socket.write(queued)
    pending.set(socket, queued.subarray(Math.max(written, 0)))
  }
  const reply = (socket: { write(data: Buffer): number }, id: unknown, result: unknown) => {
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
    pending.set(socket, Buffer.concat([pending.get(socket) ?? Buffer.alloc(0), bytes]))
    flush(socket)
  }
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        state.openConnections += 1
        buffers.set(socket, '')
      },
      drain(socket) {
        flush(socket as never)
      },
      close(socket) {
        state.openConnections -= 1
        buffers.delete(socket)
      },
      data(socket, chunk) {
        let buffer = (buffers.get(socket) ?? '') + chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (line.trim().length === 0) continue
          const message = JSON.parse(line) as { id: unknown; method: string; params: any }
          if (message.method === 'aspc.hello') {
            reply(socket as never, message.id, {
              facadeInfo: { name: 'aspc-facade', version: 'aspd-double' },
              protocolVersion: 'aspc/0.1',
              capabilities: {
                compileRuntimePlan: true,
                catalogAgents: true,
                inspectAgent: true,
                catalogAgentInspection: true,
                inspectAgentSelection: true,
                compileHarnessInvocation: true,
                compileAndStart: false,
                cohostedBroker: false,
                transports: ['unix-jsonrpc-ndjson'],
              },
              release: {
                releaseId: state.serving.releaseId,
                sourceCommit: state.serving.sourceCommit,
                builtAt: state.serving.builtAt,
              },
              ...(state.helloOverride ?? {}),
            })
          } else if (message.method === 'aspc.compileHarnessInvocation') {
            state.compileCalls += 1

            const identity = message.params.compileRequest.identity as RuntimeIdentityAllocation
            const { profile, startRequest } = makeBrokerProfile(identity, {
              initialInputText: message.params.compileRequest.materialization.initialPrompt,
            })
            const compileResponse = makeCompileResponse(identity, [profile])
            if (!compileResponse.ok) throw new Error('fixture compile rejected')
            reply(socket as never, message.id, {
              schemaVersion: 'aspc-compile-harness-invocation-response/v1',
              ok: true,
              compileResponse,
              plan: compileResponse.plan,
              selectedProfile: profile,
              startRequest,
              dispatchRequest: { startRequest },
              diagnostics: [],
              ...(state.omitExecutionRelease
                ? {}
                : { executionRelease: executionReleaseOf(state.serving) }),
            })
          }
        }
        buffers.set(socket, buffer)
      },
    },
  })
  return state
}

// ── Worker + tmux doubles ─────────────────────────────────────────────────────

type HostingLedger = {
  commands: string[]
  killedServers: string[]
  startCalls: Array<{ request: InvocationStartRequest; dispatch: unknown }>
  attachCalls: number
  helloReleaseOverride?: BrokerHelloResponse['release'] | null | undefined
  startThrows?: Error | undefined
  onFirstHostingEffect?: (() => void) | undefined
}

function capabilities(): InvocationStartResponse['capabilities'] {
  return {
    input: {
      user: true,
      steer: false,
      appendContext: false,
      localImages: false,
      fileRefs: false,
      queue: false,
    },
    turns: { concurrency: 'single', interrupt: 'protocol' },
    continuation: { supported: false, provider: 'openai', keyKind: 'session' },
    events: {
      assistantDeltas: true,
      toolCalls: true,
      usage: false,
      diagnostics: false,
      replay: false,
      ack: false,
    },
    control: { stop: true, dispose: true, status: true, attach: false },
    permissions: { brokerToClientRequests: true, eventAudit: false },
  } as unknown as InvocationStartResponse['capabilities']
}

function releaseFromCommand(command: string | undefined, releases: Release[]) {
  const match = releases.find((release) => command?.includes(release.releaseRoot))
  return match === undefined
    ? undefined
    : { releaseId: match.releaseId, sourceCommit: match.sourceCommit, builtAt: match.builtAt }
}

function workerClient(ledger: HostingLedger, releases: Release[], command: string | undefined) {
  const events: AsyncIterable<InvocationEventEnvelope> = {
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
  }
  return {
    onPermissionRequest() {},
    onClose() {},
    async hello(): Promise<BrokerHelloResponse> {
      const release =
        ledger.helloReleaseOverride === null
          ? undefined
          : (ledger.helloReleaseOverride ?? releaseFromCommand(command, releases))
      return {
        brokerInfo: { name: 'harness-broker', version: '0.2.0-test' },
        protocolVersion: 'harness-broker/0.2',
        capabilities: {
          multiInvocation: false,
          transports: ['unix-jsonrpc-ndjson'],
          eventNotifications: true,
          brokerToClientRequests: true,
          attachReplay: true,
        },
        drivers: [
          {
            kind: 'codex-app-server',
            version: '0.2.0-test',
            available: true,
            capabilities: capabilities(),
          },
        ],
        ...(release !== undefined ? { release } : {}),
      } as BrokerHelloResponse
    },
    async health() {
      return { status: 'ok' as const, activeInvocations: 0, drivers: [] }
    },
    async startInvocationFromRequest(request: InvocationStartRequest, dispatch: unknown) {
      ledger.startCalls.push({ request, dispatch })
      if (ledger.startThrows) throw ledger.startThrows
      return {
        invocationId: String(request.spec.invocationId),
        response: {
          invocationId: String(request.spec.invocationId),
          state: 'ready',
          capabilities: capabilities(),
        },
        events,
      }
    },
    async dispose() {},
    async close() {},
    async attach() {
      ledger.attachCalls += 1
      throw new Error('attach reached')
    },
    async snapshot() {
      return {}
    },
    async eventsSince() {
      return { events: [] }
    },
    async ackEvents() {
      return {}
    },
  }
}

function tmuxManagerDouble(ledger: HostingLedger) {
  return ({ socketPath }: { socketPath: string }) => ({
    async initialize() {},
    async killServer() {
      ledger.killedServers.push(socketPath)
    },
    async createWindowWithCommand(input: {
      sessionName: string
      windowName: string
      command: string
    }) {
      ledger.onFirstHostingEffect?.()
      ledger.onFirstHostingEffect = undefined
      ledger.commands.push(input.command)
      return {
        socketPath,
        sessionId: '$1',
        windowId: '@1',
        paneId: '%1',
        sessionName: input.sessionName,
        windowName: input.windowName,
      }
    },
    async createOrInspectWindow(input: { sessionName: string; windowName: string }) {
      return { socketPath, sessionId: '$1', windowId: '@2', paneId: '%2', ...input }
    },
    async inspectPaneProcess() {
      return { command: 'harness-broker', pid: 4242, dead: false }
    },
  })
}

// ── Harness ───────────────────────────────────────────────────────────────────

let fixture: HrcServerTestFixture
let server: HrcServer
let scratch: string
let aspdSocket: string
let aspd: AspdDouble
let releaseA: Release
let releaseB: Release
let ledger: HostingLedger
let facadeSpy: ReturnType<typeof spyOn>
const savedEnv: Record<string, string | undefined> = {}

type Internal = {
  db: HrcDatabase
  options: { runtimeRoot: string }
  harnessBrokerController?: HarnessBrokerController
  startHeadlessBrokerRuntime(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string,
    options?: Record<string, unknown>
  ): Promise<HrcRuntimeSnapshot>
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

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08542-')
  scratch = await mkdtemp(join(tmpdir(), 't8542-'))
  releaseA = makeRelease(join(scratch, 'releases'), 'a')
  releaseB = makeRelease(join(scratch, 'releases'), 'b')
  aspdSocket = join(scratch, 'aspd.sock')
  aspd = startAspdDouble(aspdSocket, releaseA)
  setEnv('HRC_ASPD_SOCKET', aspdSocket)
  setEnv('HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION', undefined)
  // A resolver-governed selection that would be wrong if this route consulted it.
  setEnv('HRC_HARNESS_BROKER_CMD', '/nonexistent/resolver-selected-harness-broker')

  server = await createHrcServer(
    fixture.serverOpts({ headlessCodexBrokerEnabled: true, otelListenerEnabled: false })
  )
  ledger = { commands: [], killedServers: [], startCalls: [], attachCalls: 0 }
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
  facadeSpy = spyOn(AspcFacadeBrokerClient, 'start').mockImplementation(async () => {
    throw new Error('bundled facade must not be reached on the aspd route')
  })
})

afterEach(async () => {
  facadeSpy.mockRestore()
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
    expect(facadeSpy).not.toHaveBeenCalled()
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
    expect(record.response.dispatchRequest.startRequest).toEqual(ledger.startCalls[0]!.request)
    const persisted = persistedAspdExecutionRelease(
      internal().db.runtimes.getByRuntimeId(runtime.runtimeId)!
    )
    expect(persisted?.releaseId).toBe(releaseA.releaseId)
    await Bun.sleep(20)
    expect(aspd.openConnections).toBe(0)
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

    expect(facadeSpy).not.toHaveBeenCalled()
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

  it('leaves the facade route untouched when no endpoint is configured', async () => {
    setEnv('HRC_ASPD_SOCKET', undefined)
    const s = await session()
    await expect(
      internal().startHeadlessBrokerRuntime(s, headlessIntent(), 'x', 'run-t08542-facade')
    ).rejects.toBeDefined()
    expect(facadeSpy).toHaveBeenCalledTimes(1)
    expect(aspd.compileCalls).toBe(0)
  })
})
