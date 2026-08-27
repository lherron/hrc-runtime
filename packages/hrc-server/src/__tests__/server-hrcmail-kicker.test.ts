import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { DispatchTurnResponse, HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase, HrcMailDriveAttempt } from 'hrc-store-sqlite'

import { appendHrcEvent } from '../hrc-event-helper.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { resolveHrcMailKickerEnabled, resolveHrcMailMaxRounds } from '../option-resolvers.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

/**
 * T-07615 (T-07612 wave 3) — HRC drives the wrkq collaboration ledger.
 *
 * The spec's §15 bundle-2 consumer half: presented exactly once per
 * driveAttemptId across insert/completion/sweep races and a kill between
 * attempt persistence and dispatch; `fyi` never summons; `reply_required`
 * summons through the summon gate; the `history:` cue is keyed to the runtime.
 */

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07615/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07615'
const SENDER = 'mable@hrc-runtime:T-07615'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let crashChild: ReturnType<typeof Bun.spawn> | undefined
let originalCwd: string
let originalAgentsRoot: string | undefined
let agentsRoot: string

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-mail-kicker-')
  ledger = new FakeWrkqLedger()

  // The kicker BUILDS the runtime intent for a cold target from the agent's own
  // profile on this node, because wrkq stores only the verbatim directive block.
  // So the target has to have a real agent home for a cold summon to be possible
  // at all -- which is the same thing production requires.
  originalCwd = process.cwd()
  originalAgentsRoot = process.env['ASP_AGENTS_ROOT']
  const workspaceRoot = await realpath(fixture.tmpDir)
  agentsRoot = join(workspaceRoot, 'collective', 'var', 'agents')
  await mkdir(join(workspaceRoot, 'collective', 'hrc-runtime', '.git'), { recursive: true })
  await mkdir(join(agentsRoot, 'kicker-proof'), { recursive: true })
  await writeFile(join(agentsRoot, 'kicker-proof', 'agent-profile.toml'), 'version = 3\n')
  process.chdir(join(workspaceRoot, 'collective'))
  process.env['ASP_AGENTS_ROOT'] = agentsRoot
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
  process.chdir(originalCwd)
  if (originalAgentsRoot === undefined) {
    Reflect.deleteProperty(process.env, 'ASP_AGENTS_ROOT')
  } else {
    process.env['ASP_AGENTS_ROOT'] = originalAgentsRoot
  }
  await fixture.cleanup()
})

function say(overrides: Partial<Parameters<FakeWrkqLedger['say']>[0]> = {}) {
  return ledger.say({ toScopeRef: SCOPE, fromScopeRef: SENDER, ...overrides })
}

async function startServer(options: Record<string, unknown> = {}): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
      ...options,
    })
  )
  return server
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

function startedAttempts(db: HrcDatabase) {
  return db.mailDrives
    .listAttempts(TARGET)
    .filter((attempt) => attempt.state === 'started' || attempt.state === 'completed')
}

/**
 * The run id of the nth attempt that actually reached a runtime.
 *
 * Dispatch being CALLED is not the same as the turn having started: the drive
 * records its start from the `turn.started` event, so the wait is on the durable
 * attempt state rather than on a call counter.
 */
async function startedRunId(db: HrcDatabase, index: number): Promise<string> {
  await waitUntil(() => startedAttempts(db).length > index, `attempt ${index} started`)
  return startedAttempts(db)[index]?.runId as string
}

function queryCount(db: HrcDatabase, table: string): number {
  const row = db.sqlite.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
  return row?.count ?? 0
}

/**
 * A deterministic dispatch that reuses ONE runtime per host session, the way a
 * real session does. `rotateRuntime` stands in for a `/quit`: continuation is
 * cleared and the next turn runs in a NEW runtime inside the SAME generation,
 * which is precisely the case §7's history cue is keyed to.
 */
function installDeterministicStart(serverInstance: HrcServer): {
  calls: () => number
  prompts: () => string[]
  rotateRuntime: () => void
} {
  let calls = 0
  let runtimeGeneration = 0
  const prompts: string[] = []
  const runtimesBySession = new Map<string, string>()
  ;(serverInstance as any).dispatchTurnForSession = async (
    session: HrcSessionRecord,
    _intent: HrcRuntimeIntent,
    prompt: string,
    options: { runId: string }
  ): Promise<Response> => {
    calls += 1
    prompts.push(prompt)
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
    const sessionKey = `${session.hostSessionId}:${runtimeGeneration}`
    const runtimeId =
      runtimesBySession.get(sessionKey) ?? `rt-${session.hostSessionId}-${runtimeGeneration}`
    const reused = db.runtimes.getByRuntimeId(runtimeId)
    runtimesBySession.set(sessionKey, runtimeId)
    if (reused !== null) {
      db.runtimes.update(runtimeId, {
        status: 'busy',
        statusChangedAt: now,
        updatedAt: now,
      })
      db.runtimes.updateRunId(runtimeId, runId, now)
    } else {
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
    }
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
  return {
    calls: () => calls,
    prompts: () => prompts,
    rotateRuntime: () => {
      const db = (serverInstance as any).db as HrcDatabase
      const now = timestamp()
      for (const runtimeId of runtimesBySession.values()) {
        db.runtimes.update(runtimeId, {
          status: 'exited',
          statusChangedAt: now,
          updatedAt: now,
        })
      }
      runtimeGeneration += 1
    },
  }
}

async function completeRun(serverInstance: HrcServer, runId: string): Promise<void> {
  const db = (serverInstance as any).db as HrcDatabase
  const run = db.runs.getByRunId(runId)
  if (run === null) throw new Error(`missing run ${runId}`)
  const now = timestamp()
  db.runs.markCompleted(runId, { status: 'completed', completedAt: now, updatedAt: now })
  if (run.runtimeId !== undefined) {
    db.runtimes.updateRunId(run.runtimeId, undefined, now)
    db.runtimes.update(run.runtimeId, { status: 'ready', statusChangedAt: now, updatedAt: now })
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

describe('T-07615 — HRC drives the wrkq collaboration ledger', () => {
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

  it('presents exactly once per driveAttemptId across racing insert/completion/sweep wakes', async () => {
    const envelope = say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    ;(server as any).requestMailKickerWake(TARGET, 'turn_completion')
    await Promise.all([(server as any).runMailKickerSweep(), (server as any).runMailKickerSweep()])
    await waitUntil(() => deterministic.calls() === 1, 'one dispatched drive')

    const db = (server as any).db as HrcDatabase
    const attempts = db.mailDrives.listAttempts(TARGET)
    expect(attempts).toHaveLength(1)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)

    await Promise.all([(server as any).runMailKickerSweep(), (server as any).runMailKickerSweep()])
    expect(deterministic.calls()).toBe(1)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
  })

  it('injects the §7 presentation, not an inbox pointer', async () => {
    const envelope = say({ body: 'the body that must be injected verbatim' })
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'drive dispatched')

    const prompt = deterministic.prompts()[0] ?? ''
    expect(prompt).toContain('[T-07615 · mable@hrc-runtime:T-07615 → you · reply required]')
    expect(prompt).toContain('the body that must be injected verbatim')
    expect(prompt).toContain("reply: wrkc say T-07615 --to mable - <<'EOF'")
    // The envelope id is INTERNAL: inbox/show/log surface it, injection must not.
    expect(prompt).not.toContain(envelope.id)
    // No room history is ever injected; the first message in a room has no cue.
    expect(prompt).not.toContain('history:')
  })

  it('cues history per RUNTIME: cold on arrival, silent when warm, cold again after a /quit', async () => {
    await startServer()
    // A session that already exists and already has a runtime, so the cue
    // decision is about the runtime and not about a birth.
    const resolved = await fixture.resolveSession(SCOPE)
    const db = (server as any).db as HrcDatabase
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: `rt-${resolved.hostSessionId}-0`,
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    const deterministic = installDeterministicStart(server as HrcServer)

    // Two messages already in the room, so there IS history to cue.
    const first = say({ body: 'first' })
    say({ body: 'second' })
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'first drive')
    expect(deterministic.prompts()[0]).toContain('history: wrkc log T-07615')

    ledger.ack(first.id)
    await completeRun(server as HrcServer, await startedRunId(db, 0))

    // Same WARM runtime, another message: it has seen this room, so no cue.
    say({ body: 'third' })
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 2, 'second drive')
    expect(deterministic.prompts()[1]).not.toContain('history:')

    await completeRun(server as HrcServer, await startedRunId(db, 1))

    // /quit clears continuation WITHOUT rotating the generation, so the next
    // runtime reads cold and the cue comes back. That is the whole reason wrkq
    // keys this on runtimeId rather than generation.
    deterministic.rotateRuntime()
    say({ body: 'fourth' })
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 3, 'third drive')
    expect(deterministic.prompts()[2]).toContain('history: wrkc log T-07615')
  })

  it('never summons for a fyi, and completes the attempt as a no-op', async () => {
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    // Establish the cursor first: a virgin daemon starts at "now", so anything
    // written before its first tail belongs to the sweep, not the tail.
    await (server as any).runWrkqLedgerTail()
    say({ obligation: 'fyi', body: 'for your information only' })

    // A fyi is not a wake at all: the tail skips it, so nothing is provisioned.
    await (server as any).runWrkqLedgerTail()
    await Bun.sleep(50)
    const db = (server as any).db as HrcDatabase
    expect(deterministic.calls()).toBe(0)
    expect(queryCount(db, 'sessions')).toBe(0)
  })

  it('summons a reply_required target through the gate and advances its round on a bare turn', async () => {
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    await (server as any).runWrkqLedgerTail()
    const envelope = say()

    await (server as any).runWrkqLedgerTail()
    await waitUntil(() => deterministic.calls() === 1, 'tail-triggered summon')

    const db = (server as any).db as HrcDatabase
    expect(db.sessions.listByScopeRef(SCOPE, 'main')).toHaveLength(1)

    await completeRun(server as HrcServer, await startedRunId(db, 0))
    await waitUntil(
      () => ledger.roundEndedCalls.includes(envelope.id),
      'round advanced for the undisposed envelope'
    )
    expect(ledger.envelopes.get(envelope.id)?.roundCount).toBe(1)
  })

  it('does not advance a round for a turn that answered the envelope', async () => {
    const envelope = say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => deterministic.calls() === 1, 'drive dispatched')

    // The reply IS the ack; by the time the turn ends the obligation is gone.
    ledger.ack(envelope.id)
    const db = (server as any).db as HrcDatabase
    await completeRun(server as HrcServer, await startedRunId(db, 0))
    await waitUntil(() => ledger.roundEndedCalls.includes(envelope.id), 'roundEnded consulted')
    // Only a still-presented envelope advances, so the acked one burns nothing.
    expect(ledger.envelopes.get(envelope.id)?.roundCount).toBe(0)
  })

  it('declines to drive at all while wrkq is unreachable', async () => {
    say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    ledger.unavailable = true
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await (server as any).runMailKickerSweep()
    await Bun.sleep(50)
    expect(deterministic.calls()).toBe(0)
    const db = (server as any).db as HrcDatabase
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(0)
  })

  it('tails the ledger from a persisted cursor and never replays it', async () => {
    // Traffic that predates this daemon. Replaying it would re-drive every
    // historical envelope, which is the no-cursor leak T-07620 names; the sweep,
    // not the tail, is what covers a backlog.
    say({ body: 'from before this daemon existed' })
    say({ body: 'also from before' })
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const db = (server as any).db as HrcDatabase

    await (server as any).runWrkqLedgerTail()
    await Bun.sleep(50)
    expect(deterministic.calls()).toBe(0)
    const afterFirst = db.wrkqLedgerCursors.get() as number
    expect(afterFirst).toBeGreaterThan(0)

    say({ body: 'arrived while the daemon was up' })
    await (server as any).runWrkqLedgerTail()
    await waitUntil(() => deterministic.calls() === 1, 'tail woke the new envelope')
    expect(db.wrkqLedgerCursors.get()).toBeGreaterThan(afterFirst)

    // A second tail over the same ground finds nothing new.
    await (server as any).runWrkqLedgerTail()
    await Bun.sleep(50)
    expect(deterministic.calls()).toBe(1)
  })

  it('resumes the tail from the persisted cursor rather than sweeping for a cold scope', async () => {
    await startServer()
    await (server as any).runWrkqLedgerTail()
    const db = (server as any).db as HrcDatabase
    const cursorBefore = db.wrkqLedgerCursors.get() as number
    await (server as unknown as HrcServer).stop()
    server = undefined

    // The envelope arrives while this node is DOWN. Nothing local knows the
    // scope, so the sweep -- which only covers seated scopes -- cannot find it.
    say()

    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
    const reopened = (server as any).db as HrcDatabase
    expect(reopened.wrkqLedgerCursors.get()).toBe(cursorBefore)

    await (server as any).runWrkqLedgerTail()
    await waitUntil(() => deterministic.calls() === 1, 'tail replayed the downtime gap')
  })

  it('sweeps only the scopes this node is seating, plus attempts in flight', async () => {
    await startServer()
    const db = (server as any).db as HrcDatabase
    const scopes: string[][] = []
    const realPendingView = ledger.pendingView.bind(ledger)
    ledger.pendingView = async (params) => {
      if (params.scopes !== undefined) scopes.push(params.scopes)
      return realPendingView(params)
    }

    // A pending envelope for a scope with no seat here: the sweep must not go
    // looking for it, because a sweep that widens with history is a load bug.
    say()
    await (server as any).runMailKickerSweep()
    expect(scopes.flat()).not.toContain(TARGET)

    const resolved = await fixture.resolveSession(SCOPE)
    const now = timestamp()
    db.runtimes.insert({
      runtimeId: 'rt-seated',
      runtimeKind: 'harness',
      hostSessionId: resolved.hostSessionId,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: resolved.generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    const deterministic = installDeterministicStart(server as HrcServer)
    await (server as any).runMailKickerSweep()
    await waitUntil(() => deterministic.calls() === 1, 'seated scope swept')
  })

  it('leaves a busy target alone until its turn completes', async () => {
    await startServer()
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
    const deterministic = installDeterministicStart(server as HrcServer)

    say()
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await Bun.sleep(50)
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(0)

    await completeRun(server as HrcServer, 'run-busy-v1')
    await waitUntil(() => deterministic.calls() === 1, 'completion-triggered drive')
    expect(db.mailDrives.listAttempts(TARGET)).toHaveLength(1)
  })

  it('B2.1: a daemon kill after the slot CAS recovers one attempt and one START', async () => {
    const markerPath = join(fixture.tmpDir, 'claimed.json')
    const serverEntry = resolve(import.meta.dir, '..', 'index.ts')
    const ledgerEntry = resolve(import.meta.dir, 'fixtures', 'fake-wrkq-ledger.ts')
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
    // The child seeds the SAME envelope id the parent will see, so the crash
    // boundary is the only difference between the two processes' ledgers.
    const childSource = `
        import { createHrcServer } from ${JSON.stringify(serverEntry)};
        import { FakeWrkqLedger } from ${JSON.stringify(ledgerEntry)};
        const options = JSON.parse(process.env.HRC_MAIL_CRASH_OPTIONS);
        const markerPath = process.env.HRC_MAIL_CRASH_MARKER;
        const ledger = new FakeWrkqLedger();
        ledger.say({ toScopeRef: ${JSON.stringify(SCOPE)}, fromScopeRef: ${JSON.stringify(SENDER)} });
        const server = await createHrcServer({
          ...options,
          wrkqLedger: ledger,
          hrcMailKickerAfterClaim: async (attempt) => {
            await Bun.write(markerPath, JSON.stringify(attempt));
            await new Promise(() => undefined);
          },
        });
        server.requestMailKickerWake(${JSON.stringify(TARGET)}, 'insert');
        await new Promise(() => undefined);
      `
    crashChild = Bun.spawn({
      cmd: [process.execPath, '-e', childSource],
      env: {
        ...process.env,
        HRC_MAIL_CRASH_OPTIONS: JSON.stringify(childOptions),
        HRC_MAIL_CRASH_MARKER: markerPath,
        ASP_AGENTS_ROOT: agentsRoot,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })

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

    const envelope = say()
    await startServer()
    const deterministic = installDeterministicStart(server as HrcServer)
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
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
    expect(
      db.hrcEvents.listByRun(claimed.runId).filter((event) => event.eventKind === 'turn.started')
    ).toHaveLength(1)

    await Promise.all([(server as any).runMailKickerSweep(), (server as any).runMailKickerSweep()])
    expect(deterministic.calls()).toBe(1)

    ledger.ack(envelope.id)
    await completeRun(server as HrcServer, claimed.runId)
    await (server as any).runMailKickerSweep()

    expect(db.mailDrives.getSlot(TARGET)?.activeDriveAttemptId).toBeUndefined()
    expect(db.mailDrives.getAttempt(claimed.driveAttemptId)?.state).toBe('completed')
    expect(deterministic.calls()).toBe(1)
  }, 20_000)
})
