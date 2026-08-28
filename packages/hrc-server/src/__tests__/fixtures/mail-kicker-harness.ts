import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  DispatchTurnResponse,
  HrcLifecycleEvent,
  HrcLifecycleTransport,
  HrcRuntimeIntent,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { appendHrcEvent } from '../../hrc-event-helper.js'
import type { HrcServer } from '../../index.js'
import { timestamp } from '../../server-util.js'

/**
 * The shared harness behind the wrkq-kicker suites (T-07615, T-07643).
 *
 * These are the seams every kicker test needs and none of them owns: a real
 * agent home on disk (the kicker BUILDS a cold target's intent from the agent's
 * profile, so a summon is impossible without one), a deterministic dispatch
 * that reuses one runtime per host session, and the small waits that key on
 * DURABLE state rather than on call counters.
 *
 * It lives in `fixtures/` because a test file that carries its own copy is a
 * test file that drifts from the other one's idea of what a drive looks like.
 */

type ServerDispatch = (
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  options: { runId: string }
) => Promise<Response>

/**
 * The daemon-internal surface these fixtures stand on, named once.
 *
 * A test that reaches past the public server API should say WHAT it is reaching
 * for; `as any` at every call site says only that it gave up, and it hides the
 * day one of these members is renamed.
 */
type ServerInternals = {
  db: HrcDatabase
  dispatchTurnForSession: ServerDispatch
  notifyEvent: (event: HrcLifecycleEvent) => void
}

export function serverInternals(serverInstance: HrcServer): ServerInternals {
  return serverInstance as unknown as ServerInternals
}

/** A real agent home for the target, plus the cwd/env the placement resolver reads. */
export async function installMailKickerAgentHome(
  tmpDir: string,
  agentId: string
): Promise<{ agentsRoot: string; restore: () => void }> {
  const originalCwd = process.cwd()
  const originalAgentsRoot = process.env['ASP_AGENTS_ROOT']
  const workspaceRoot = await realpath(tmpDir)
  const agentsRoot = join(workspaceRoot, 'collective', 'var', 'agents')
  await mkdir(join(workspaceRoot, 'collective', 'hrc-runtime', '.git'), { recursive: true })
  await mkdir(join(agentsRoot, agentId), { recursive: true })
  await writeFile(join(agentsRoot, agentId, 'agent-profile.toml'), 'version = 3\n')
  process.chdir(join(workspaceRoot, 'collective'))
  process.env['ASP_AGENTS_ROOT'] = agentsRoot
  return {
    agentsRoot,
    restore: () => {
      process.chdir(originalCwd)
      if (originalAgentsRoot === undefined) {
        Reflect.deleteProperty(process.env, 'ASP_AGENTS_ROOT')
      } else {
        process.env['ASP_AGENTS_ROOT'] = originalAgentsRoot
      }
    },
  }
}

export async function waitUntil(
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

export function startedAttempts(db: HrcDatabase, target: string) {
  return db.mailDrives
    .listAttempts(target)
    .filter((attempt) => attempt.state === 'started' || attempt.state === 'completed')
}

/**
 * The run id of the nth attempt that actually reached a runtime.
 *
 * Dispatch being CALLED is not the same as the turn having started: the drive
 * records its start from the `turn.started` event, so the wait is on the durable
 * attempt state rather than on a call counter.
 */
export async function startedRunId(
  db: HrcDatabase,
  target: string,
  index: number
): Promise<string> {
  await waitUntil(() => startedAttempts(db, target).length > index, `attempt ${index} started`)
  return startedAttempts(db, target)[index]?.runId as string
}

/**
 * Capture the daemon's own stderr for one bounded window, so a "skipped and
 * logged" claim can be checked rather than inferred. Scoped to the call and
 * restored afterwards: swapping stderr for a whole file swallows every other
 * test's diagnostics.
 *
 * `lines` is handed to the callback as well as returned, so a wait can key on a
 * log line that is written AFTER the state change that produced it.
 */
export async function captureServerLog<T>(
  run: (lines: string[]) => Promise<T>
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk))
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  try {
    return { result: await run(lines), lines }
  } finally {
    process.stderr.write = original
  }
}

export function queryCount(db: HrcDatabase, table: string): number {
  const row = db.sqlite.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
  return row?.count ?? 0
}

export type DeterministicStart = {
  calls: () => number
  prompts: () => string[]
  inputIds: () => string[]
  rotateRuntime: () => void
}

/**
 * A deterministic dispatch that reuses ONE runtime per host session, the way a
 * real session does. `rotateRuntime` stands in for a `/quit`: continuation is
 * cleared and the next turn runs in a NEW runtime inside the SAME generation,
 * which is precisely the case §7's history cue is keyed to.
 */
export function installDeterministicStart(serverInstance: HrcServer): DeterministicStart {
  let calls = 0
  let runtimeGeneration = 0
  const prompts: string[] = []
  const inputIds: string[] = []
  const runtimesBySession = new Map<string, string>()
  serverInternals(serverInstance).dispatchTurnForSession = async (
    session: HrcSessionRecord,
    _intent: HrcRuntimeIntent,
    prompt: string,
    options: { runId: string }
  ): Promise<Response> => {
    calls += 1
    prompts.push(prompt)
    const db = serverInternals(serverInstance).db
    const runId = options.runId
    const inputId = `input-${runId}`
    inputIds.push(inputId)
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
    const seededRuntimes = db.runtimes.listByHostSessionId(session.hostSessionId)
    let seededRuntime = null
    for (let index = seededRuntimes.length - 1; index >= 0; index -= 1) {
      const candidate = seededRuntimes[index]
      if (candidate === undefined) continue
      if (
        candidate.generation === session.generation &&
        candidate.status !== 'terminated' &&
        candidate.status !== 'zombie' &&
        candidate.status !== 'exited'
      ) {
        seededRuntime = candidate
        break
      }
    }
    const runtimeId =
      runtimesBySession.get(sessionKey) ??
      seededRuntime?.runtimeId ??
      `rt-${session.hostSessionId}-${runtimeGeneration}`
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
      dispatchedInputId: inputId,
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
    serverInternals(serverInstance).notifyEvent(started)
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
    inputIds: () => inputIds,
    rotateRuntime: () => {
      const db = serverInternals(serverInstance).db
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

/**
 * A run row stores its transport as a plain string; the lifecycle event wants
 * the closed union. Narrow rather than cast, so a fixture can never mint an
 * event carrying a transport the contract does not name.
 */
function asLifecycleTransport(value: string): HrcLifecycleTransport | undefined {
  return value === 'sdk' || value === 'tmux' || value === 'headless' ? value : undefined
}

export async function completeRun(serverInstance: HrcServer, runId: string): Promise<void> {
  const db = serverInternals(serverInstance).db
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
    transport: asLifecycleTransport(run.transport),
    payload: { success: true },
  })
  serverInternals(serverInstance).notifyEvent(completed)
}
