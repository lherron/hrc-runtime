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
 * T-07616 (T-07612 wave 4) — `--urgent` actuation in the kicker.
 *
 * Split out of `server-hrcmail-kicker.test.ts`, which is at the repo's
 * authored-test-size ceiling; the harness below is the same one, trimmed to
 * what these cases need.
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

describe('T-07616 — urgent actuation', () => {
  /**
   * T-07616 — `--urgent` actuation. Before this, the flag was parsed into the
   * envelope and read by nothing, so an urgent envelope queued behind a long
   * turn exactly like an ordinary one.
   *
   * These patch `dispatchTurnForSession` rather than driving a real broker:
   * what is under test is the KICKER's gating, receipt and round semantics.
   * Whether a steer actually reaches a pane is T-07203's contract, already
   * covered by its own suite, and re-proving it here would test the double.
   */
  describe('urgent steers into a busy target', () => {
    const PRESENTED_TO_LIVE_HARNESS = {
      code: 'presented_to_live_harness',
      delivery: 'presented',
      presentedDuringRunId: 'run-busy-v1',
      deliverySemantics: 'pane_presentation',
      ackSemantics: 'pane_write_only',
    } as const

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

    function captureDispatch(outcome: unknown | 'throw'): { prompts: () => string[] } {
      const prompts: string[] = []
      ;(server as any).dispatchTurnForSession = async (
        _session: HrcSessionRecord,
        _intent: HrcRuntimeIntent,
        prompt: string
      ): Promise<Response> => {
        prompts.push(prompt)
        if (outcome === 'throw') throw new Error('no steerable broker endpoint')
        return Response.json({ runId: 'run-busy-v1', delivery: outcome })
      }
      return { prompts: () => prompts }
    }

    it('steers the urgent envelope in and records the receipt without advancing rounds', async () => {
      await startServer()
      await makeBusyTarget()
      const dispatch = captureDispatch(PRESENTED_TO_LIVE_HARNESS)

      const envelope = say({ urgent: true, body: 'the urgent body' })
      ;(server as any).requestMailKickerWake(TARGET, 'insert')
      await waitUntil(() => dispatch.prompts().length === 1, 'urgent steer dispatched')

      // The §7 body reached the live turn...
      expect(dispatch.prompts()[0] ?? '').toContain('the urgent body')
      // ...the ledger holds one receipt for it...
      expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
      // ...and the redelivery bound did NOT move: rounds measure "shown by a
      // kicker-driven turn and ignored", which a mid-turn steer is not.
      expect(ledger.roundEndedCalls).toEqual([])
      expect(ledger.envelopes.get(envelope.id)?.roundCount).toBe(0)
      // A steer is not a drive: it never claims the per-scope drive slot.
      expect(((server as any).db as HrcDatabase).mailDrives.listAttempts(TARGET)).toHaveLength(0)
    })

    it('interrupts a given turn at most once for the same envelope', async () => {
      await startServer()
      await makeBusyTarget()
      const dispatch = captureDispatch(PRESENTED_TO_LIVE_HARNESS)

      say({ urgent: true })
      ;(server as any).requestMailKickerWake(TARGET, 'insert')
      await waitUntil(() => dispatch.prompts().length === 1, 'first steer')

      // Rounds never advance for a steer, so nothing else bounds this: without
      // the once-per-run gate the floor would re-steer the same envelope into
      // the same turn forever.
      ;(server as any).requestMailKickerWake(TARGET, 'periodic')
      await Bun.sleep(60)
      expect(dispatch.prompts()).toHaveLength(1)
    })

    it('leaves a NON-urgent envelope to wait, exactly as before', async () => {
      await startServer()
      await makeBusyTarget()
      const dispatch = captureDispatch(PRESENTED_TO_LIVE_HARNESS)

      const envelope = say()
      ;(server as any).requestMailKickerWake(TARGET, 'insert')
      await Bun.sleep(60)

      expect(dispatch.prompts()).toHaveLength(0)
      expect(ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])
      expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    })

    it('records nothing when the steer fails typed, and never downgrades it to a queue', async () => {
      await startServer()
      await makeBusyTarget()
      const dispatch = captureDispatch('throw')

      const envelope = say({ urgent: true })
      ;(server as any).requestMailKickerWake(TARGET, 'insert')
      await waitUntil(() => dispatch.prompts().length === 1, 'steer attempted')
      await Bun.sleep(30)

      // No honest class could be proven, so the ledger records NO presentation:
      // a receipt for a presentation that did not happen is worse than none.
      expect(ledger.envelopes.get(envelope.id)?.presentedTo).toEqual([])
      expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
      expect(ledger.roundEndedCalls).toEqual([])
    })
  })
})
