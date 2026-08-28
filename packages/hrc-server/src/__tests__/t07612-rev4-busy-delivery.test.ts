import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

/**
 * T-07612 rev 4 — one delivery class. A busy target is not a reason to wait.
 *
 * Replaces the T-07616 `--urgent` suite: there is no urgent flag any more, and
 * every envelope reaching a seat mid-turn is handed to the broker with its
 * ordinary queue policy, the way the `hrcchat dm` default always was. Split
 * out of `server-hrcmail-kicker.test.ts`, which is at the repo's
 * authored-test-size ceiling; the harness below is the same one, trimmed.
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

describe('T-07612 rev 4 — a busy target receives mail in-flight', () => {
  /**
   * These patch `dispatchTurnForSession` rather than driving a real broker:
   * what is under test is the KICKER's gating and receipt semantics. That the
   * route hands the broker `whenBusy:'queue'` when `whenBusy` is undefined is
   * the broker routes' own contract, covered by their suites.
   */
  async function makeBusyTarget(): Promise<{ hostSessionId: string; generation: number }> {
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
    return resolved
  }

  type Dispatch = { prompt: string; whenBusy: string | undefined; runId: string | undefined }

  function captureDispatch(outcome: 'accept' | 'throw'): { calls: () => Dispatch[] } {
    const calls: Dispatch[] = []
    ;(server as any).dispatchTurnForSession = async (
      session: HrcSessionRecord,
      _intent: HrcRuntimeIntent,
      prompt: string,
      options: { runId?: string | undefined; whenBusy?: string | undefined }
    ): Promise<Response> => {
      calls.push({ prompt, whenBusy: options.whenBusy, runId: options.runId })
      if (outcome === 'throw') throw new Error('broker refused the input')
      const runId = options.runId ?? 'run-queued'
      // A run row, as the real route writes one: without it the kicker reads
      // a persisted attempt with no run as "killed before dispatch" and replays.
      const db = (server as any).db as HrcDatabase
      const now = timestamp()
      if (db.runs.getByRunId(runId) === null) {
        db.runs.insert({
          runId,
          hostSessionId: session.hostSessionId,
          runtimeId: 'rt-busy-v1',
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          transport: 'headless',
          status: 'started',
          acceptedAt: now,
          startedAt: now,
          updatedAt: now,
        })
      }
      return Response.json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: 'rt-busy-v1',
        transport: 'headless',
        status: 'started',
        inputId: `input-${runId}`,
        supportsInFlightInput: false,
      })
    }
    return { calls: () => calls }
  }

  it('delivers a plain envelope into the live turn at once, with the queue policy', async () => {
    await startServer()
    await makeBusyTarget()
    const dispatch = captureDispatch('accept')

    const envelope = say({ body: 'the mid-turn body' })
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => dispatch.calls().length === 1, 'busy delivery dispatched')
    await waitUntil(
      () => (ledger.envelopes.get(envelope.id)?.presentedTo.length ?? 0) === 1,
      'receipt committed'
    )

    const call = dispatch.calls()[0]
    expect(call?.prompt ?? '').toContain('the mid-turn body')
    // No `reject`, no `steer`: the route's own queue policy is what reaches the
    // broker, applied only if the harness reports a turn active.
    expect(call?.whenBusy).toBeUndefined()
    // The receipt joins the accepted input.
    const receipt = ledger.envelopes.get(envelope.id)?.presentedTo[0]
    expect(receipt?.inputId).toBe(`input-${call?.runId}`)
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('presented')
  })

  it('delivers a fyi into the live turn too, and it is acked on commit', async () => {
    await startServer()
    await makeBusyTarget()
    const dispatch = captureDispatch('accept')

    const envelope = say({ obligation: 'fyi', body: 'a fyi that does not wait' })
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => dispatch.calls().length === 1, 'fyi dispatched')
    await waitUntil(() => ledger.envelopes.get(envelope.id)?.state === 'acked', 'fyi acked')
    expect(dispatch.calls()[0]?.prompt ?? '').toContain('a fyi that does not wait')
  })

  it('does not hand the same envelope to the seat twice on the next sweep', async () => {
    await startServer()
    await makeBusyTarget()
    const dispatch = captureDispatch('accept')

    const envelope = say()
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(
      () => (ledger.envelopes.get(envelope.id)?.presentedTo.length ?? 0) === 1,
      'first delivery'
    )
    // The redelivery floor, measured from the receipt, is what bounds this.
    ;(server as any).requestMailKickerWake(TARGET, 'periodic')
    await Bun.sleep(60)
    expect(dispatch.calls()).toHaveLength(1)
  })

  it('records nothing when the broker refuses the input', async () => {
    await startServer()
    await makeBusyTarget()
    const dispatch = captureDispatch('throw')

    const envelope = say()
    ;(server as any).requestMailKickerWake(TARGET, 'insert')
    await waitUntil(() => dispatch.calls().length === 1, 'delivery attempted')
    await Bun.sleep(30)

    // A receipt for a presentation that did not happen is worse than none.
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    expect(ledger.roundEndedCalls).toEqual([])
  })
})
