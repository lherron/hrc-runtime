import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type {
  DispatchTurnResponse,
  HrcMailSendRequest,
  HrcRuntimeIntent,
  HrcSessionRecord,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase, HrcMailDriveAttempt } from 'hrc-store-sqlite'

import { appendHrcEvent } from '../hrc-event-helper.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { resolveHrcMailKickerEnabled, resolveHrcMailMaxRounds } from '../option-resolvers.js'
import { timestamp } from '../server-util.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-06810/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-06810'
const SENDER = 'agent:mable:project:hrc-runtime:task:T-06810/lane:main'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let crashChild: ReturnType<typeof Bun.spawn> | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-mail-kicker-')
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  if (crashChild !== undefined) {
    crashChild.kill(9)
    await crashChild.exited.catch(() => undefined)
    crashChild = undefined
  }
  await fixture.cleanup()
})

function intent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider: 'openai',
      id: 'codex-cli',
      interactive: false,
    },
    execution: { preferredMode: 'nonInteractive' },
  }
}

function request(ingressId: string): HrcMailSendRequest {
  return {
    ingressId,
    from: { kind: 'scope', sessionRef: SENDER },
    targetSessionRef: TARGET,
    payload: { kind: 'request', body: 'prove the durable kicker' },
    materializationIntent: intent(),
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function queryCount(db: HrcDatabase, table: string): number {
  const row = db.sqlite.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
  return row?.count ?? 0
}

function installDeterministicStart(serverInstance: HrcServer): { calls: () => number } {
  let calls = 0
  ;(serverInstance as any).dispatchTurnForSession = async (
    session: HrcSessionRecord,
    _intent: HrcRuntimeIntent,
    _prompt: string,
    options: { runId: string }
  ): Promise<Response> => {
    calls += 1
    const db = (serverInstance as any).db as HrcDatabase
    const runId = options.runId
    const existing = db.runs.getByRunId(runId)
    if (existing !== null) {
      return Response.json({
        runId,
        hostSessionId: existing.hostSessionId,
        generation: existing.generation,
        runtimeId: existing.runtimeId,
        transport: existing.transport,
        status: existing.status === 'completed' ? 'completed' : 'started',
        supportsInFlightInput: false,
      } as DispatchTurnResponse)
    }

    const now = timestamp()
    const runtimeId = `rt-${runId}`
    db.runtimes.insert({
      runtimeId,
      runtimeKind: 'harness',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'busy',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      activeRunId: runId,
      createdAt: now,
      updatedAt: now,
    })
    db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
    const started = appendHrcEvent(db, 'turn.started', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId,
      runId,
      transport: 'headless',
    })
    ;(serverInstance as any).notifyEvent(started)
    return Response.json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId,
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
    } as DispatchTurnResponse)
  }
  return { calls: () => calls }
}

async function completeRun(serverInstance: HrcServer, runId: string): Promise<void> {
  const db = (serverInstance as any).db as HrcDatabase
  const run = db.runs.getByRunId(runId)
  if (run === null) throw new Error(`missing run ${runId}`)
  const now = timestamp()
  db.runs.markCompleted(runId, { status: 'completed', completedAt: now, updatedAt: now })
  if (run.runtimeId !== undefined) {
    db.runtimes.updateRunId(run.runtimeId, undefined, now)
    db.runtimes.update(run.runtimeId, {
      status: 'ready',
      statusChangedAt: now,
      updatedAt: now,
    })
  }
  const completed = appendHrcEvent(db, 'turn.completed', {
    ts: now,
    hostSessionId: run.hostSessionId,
    scopeRef: run.scopeRef,
    laneRef: run.laneRef,
    generation: run.generation,
    runtimeId: run.runtimeId,
    runId,
    transport: run.transport,
    payload: { success: true },
  })
  ;(serverInstance as any).notifyEvent(completed)
}

describe('T-06810 Wave 2 — live isolated hrcmail kicker', () => {
  it('is dark by default and honors the named max-round override', () => {
    const originalEnabled = process.env['HRC_MAIL_KICKER_ENABLED']
    const originalMaxRounds = process.env['HRC_MAIL_MAX_ROUNDS']
    try {
      Reflect.deleteProperty(process.env, 'HRC_MAIL_KICKER_ENABLED')
      Reflect.deleteProperty(process.env, 'HRC_MAIL_MAX_ROUNDS')
      expect(resolveHrcMailKickerEnabled({} as never)).toBe(false)
      expect(resolveHrcMailMaxRounds({} as never)).toBe(5)

      process.env['HRC_MAIL_KICKER_ENABLED'] = '1'
      process.env['HRC_MAIL_MAX_ROUNDS'] = '7'
      expect(resolveHrcMailKickerEnabled({} as never)).toBe(true)
      expect(resolveHrcMailMaxRounds({} as never)).toBe(7)

      process.env['HRC_MAIL_MAX_ROUNDS'] = '7.5'
      expect(resolveHrcMailMaxRounds({} as never)).toBe(5)
    } finally {
      if (originalEnabled === undefined) {
        Reflect.deleteProperty(process.env, 'HRC_MAIL_KICKER_ENABLED')
      } else {
        process.env['HRC_MAIL_KICKER_ENABLED'] = originalEnabled
      }
      if (originalMaxRounds === undefined) {
        Reflect.deleteProperty(process.env, 'HRC_MAIL_MAX_ROUNDS')
      } else {
        process.env['HRC_MAIL_MAX_ROUNDS'] = originalMaxRounds
      }
    }
  })

  it('B2.1: literal daemon kill after slot CAS recovers one attempt and one START under racing wakes', async () => {
    const markerPath = join(fixture.tmpDir, 'claimed.json')
    const serverEntry = resolve(import.meta.dir, '..', 'index.ts')
    const childOptions = {
      runtimeRoot: fixture.runtimeRoot,
      stateRoot: fixture.stateRoot,
      socketPath: fixture.socketPath,
      lockPath: fixture.lockPath,
      spoolDir: fixture.spoolDir,
      dbPath: fixture.dbPath,
      tmuxSocketPath: fixture.tmuxSocketPath,
      otelListenerEnabled: false,
      hrcMailKickerEnabled: true,
      hrcMailKickerSweepIntervalMs: 60_000,
    }
    const childSource = `
        import { createHrcServer } from ${JSON.stringify(serverEntry)};
        const options = JSON.parse(process.env.HRC_MAIL_CRASH_OPTIONS);
        const markerPath = process.env.HRC_MAIL_CRASH_MARKER;
        await createHrcServer({
          ...options,
          hrcMailKickerAfterClaim: async (attempt) => {
            await Bun.write(markerPath, JSON.stringify(attempt));
            await new Promise(() => undefined);
          },
        });
        await new Promise(() => undefined);
      `
    crashChild = Bun.spawn({
      cmd: [process.execPath, '-e', childSource],
      env: {
        ...process.env,
        HRC_CLAUDE_GHOSTTY: '0',
        HRC_MAIL_CRASH_OPTIONS: JSON.stringify(childOptions),
        HRC_MAIL_CRASH_MARKER: markerPath,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })

    await waitUntil(async () => {
      try {
        return (await fixture.fetchSocket('/v1/health')).ok
      } catch {
        return false
      }
    }, 'crash daemon health')

    const sent = await fixture.postJson('/v1/mail/send', request('kicker-crash-ingress'))
    expect(sent.status).toBe(200)
    await waitUntil(async () => {
      try {
        await access(markerPath)
        return true
      } catch {
        return false
      }
    }, 'slot-persist crash marker')
    const claimed = JSON.parse(await readFile(markerPath, 'utf8')) as HrcMailDriveAttempt

    const beforeKill = openHrcDatabase(fixture.dbPath)
    try {
      expect(beforeKill.mailDrives.getSlot(TARGET)).toMatchObject({
        activeDriveAttemptId: claimed.driveAttemptId,
      })
      expect(beforeKill.mailDrives.listAttempts(TARGET)).toHaveLength(1)
      expect(beforeKill.runs.getByRunId(claimed.runId)).toBeNull()
      expect(queryCount(beforeKill, 'sessions')).toBe(0)
      expect(queryCount(beforeKill, 'runtimes')).toBe(0)
    } finally {
      beforeKill.close()
    }

    crashChild.kill(9)
    await crashChild.exited
    crashChild = undefined

    server = await createHrcServer(
      fixture.serverOpts({
        hrcMailKickerEnabled: true,
        hrcMailKickerSweepIntervalMs: 60_000,
        otelListenerEnabled: false,
      })
    )
    const deterministic = installDeterministicStart(server)
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    ;(server as any).requestMailKickerWake(TARGET, 'turn_completion')
    await Promise.all([(server as any).runMailKickerSweep(), (server as any).runMailKickerSweep()])

    const db = (server as any).db as HrcDatabase
    const recovered = db.mailDrives.getAttempt(claimed.driveAttemptId)
    expect(recovered).toMatchObject({
      driveAttemptId: claimed.driveAttemptId,
      runId: claimed.runId,
      state: 'started',
      presentedCount: 1,
    })
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(1)
    expect(db.sessions.listByScopeRef(SCOPE, 'main')).toHaveLength(1)
    expect(deterministic.calls()).toBe(1)
    expect(
      db.hrcEvents.listByRun(claimed.runId).filter((event) => event.eventKind === 'turn.started')
    ).toHaveLength(1)

    await Promise.all([(server as any).runMailKickerSweep(), (server as any).runMailKickerSweep()])
    expect(deterministic.calls()).toBe(1)

    db.mailEnvelopes.ack({
      actor: { kind: 'scope', sessionRef: TARGET },
      envelopeIds: [requestEnvelopeId(db, 'kicker-crash-ingress')],
    })
    await completeRun(server, claimed.runId)
    await (server as any).runMailKickerSweep()

    expect(db.mailDrives.getSlot(TARGET)?.activeDriveAttemptId).toBeUndefined()
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(1)
    expect(db.mailDrives.getAttempt(claimed.driveAttemptId)?.state).toBe('completed')
    expect(deterministic.calls()).toBe(1)
  }, 20_000)

  it('busy v1 turn leaves mail pending until the terminal-event wake', async () => {
    server = await createHrcServer(
      fixture.serverOpts({
        hrcMailKickerEnabled: true,
        hrcMailKickerSweepIntervalMs: 60_000,
        otelListenerEnabled: false,
      })
    )
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-busy-v1',
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'busy',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      activeRunId: 'run-busy-v1',
      createdAt: now,
      updatedAt: now,
    })
    db.runs.insert({
      runId: 'run-busy-v1',
      hostSessionId: resolved.hostSessionId,
      runtimeId: 'rt-busy-v1',
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
    const deterministic = installDeterministicStart(server)

    const sent = await fixture.postJson('/v1/mail/send', request('kicker-busy-ingress'))
    expect(sent.status).toBe(200)
    await Bun.sleep(50)
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(0)
    expect(db.mailEnvelopes.require(requestEnvelopeId(db, 'kicker-busy-ingress')).state).toBe(
      'pending'
    )

    await completeRun(server, 'run-busy-v1')
    await waitUntil(() => deterministic.calls() === 1, 'completion-triggered mail drive')
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(1)
  })

  it('an attempt whose inbox clears before dispatch is no-op and does not advance rounds', async () => {
    let dispatchCalls = 0
    server = await createHrcServer(
      fixture.serverOpts({
        hrcMailKickerEnabled: true,
        hrcMailKickerSweepIntervalMs: 60_000,
        otelListenerEnabled: false,
        hrcMailKickerAfterClaim: (attempt) => {
          const db = (server as any).db as HrcDatabase
          const presented = db.mailDrives.presentForAttempt(attempt.driveAttemptId, (id) =>
            db.mailEnvelopes.require(id)
          )
          db.mailEnvelopes.ack({
            actor: { kind: 'scope', sessionRef: TARGET },
            envelopeIds: presented.map((envelope) => envelope.envelopeId),
          })
        },
      })
    )
    ;(server as any).dispatchTurnForSession = async () => {
      dispatchCalls += 1
      throw new Error('clear inbox must not dispatch')
    }

    const response = await fixture.postJson('/v1/mail/send', request('kicker-clear-ingress'))
    const body = (await response.json()) as { envelope: { envelopeId: string } }
    const envelopeId = body.envelope.envelopeId
    await waitUntil(() => {
      const db = (server as any).db as HrcDatabase
      return db.mailDrives.listAttempts(TARGET)[0]?.state === 'no_op'
    }, 'clear-inbox no-op')

    const db = (server as any).db as HrcDatabase
    expect(dispatchCalls).toBe(0)
    expect(db.mailEnvelopes.require(envelopeId)).toMatchObject({
      state: 'acked',
      roundCount: 0,
    })
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(1)
  })
})

function requestEnvelopeId(db: HrcDatabase, ingressId: string): string {
  const receipt = db.mailEnvelopes.getIngressReceipt(ingressId)
  if (receipt === undefined) throw new Error(`missing receipt ${ingressId}`)
  return receipt.envelopeId
}
