import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcSessionRecord } from 'hrc-core'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import {
  deriveSessionProjectEvent,
  postParamsFor,
  taskSelectorFrom,
} from '../wrkq/session-project-events.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

/**
 * T-08389 — HRC publishes one `session.*` project event per birth.
 *
 * Two properties are load-bearing and neither is cosmetic:
 *  - ATTRIBUTE KEY ORDER. wrkq stores the object's raw bytes and renders
 *    `key=value` in producer order, so the order asserted here is literally
 *    what a human reads on `wrkp log`. An alphabetised producer buries `seat`
 *    behind `agent`/`cause`/`generation`, which is the field someone scanning
 *    a timeline actually wants.
 *  - NO BIRTH IS EVER DROPPED. ~7% of live T-shaped scope selectors do not
 *    resolve to a task (`:role:` probes, `-e2e` variants, purged ids), and
 *    wrkq answers an unresolvable task with NotFoundError before the INSERT.
 *    A naive producer silently loses exactly the probe and federation births
 *    worth debugging.
 */

const NODE = 'max3'
const OCCURRED = '2026-09-11T18:00:00.000Z'

function sessionRecord(overrides: Partial<HrcSessionRecord> = {}): HrcSessionRecord {
  return {
    hostSessionId: 'hsid-born-1',
    scopeRef: 'agent:clod:project:hrc-runtime:task:T-08389',
    laneRef: 'lane:main',
    generation: 1,
    status: 'active',
    createdAt: OCCURRED,
    updatedAt: OCCURRED,
    ancestorScopeRefs: [],
    lastAppliedIntentJson: {
      placement: {
        agentRoot: '/agents/clod',
        runMode: 'task',
        bundle: { kind: 'compose', compose: [] },
      },
      harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
    },
    ...overrides,
  }
}

describe('T-08389 — the derived fact', () => {
  it('leads with source/node/seat and carries the declared vocabulary in order', () => {
    const fact = deriveSessionProjectEvent({
      session: sessionRecord(),
      payload: { created: true, summon: true },
      node: NODE,
      occurredAt: OCCURRED,
      requestedBy: 'agent:mable',
    })

    expect(fact?.type).toBe('session.born')
    expect(Object.keys(fact?.attributes ?? {})).toEqual([
      'source',
      'node',
      'seat',
      'agent',
      'cause',
      'harness',
      'provider',
      'mode',
      'session',
      'generation',
      'runtime',
      'requested_by',
    ])
    expect(fact?.attributes).toMatchObject({
      source: 'hrc-server',
      node: 'max3',
      seat: 'agent:clod:project:hrc-runtime:task:T-08389',
      agent: 'clod',
      cause: 'summon',
      harness: 'claude-code',
      provider: 'anthropic',
      mode: 'interactive',
      session: 'hsid-born-1',
      generation: '1',
      runtime: 'harness',
      requested_by: 'agent:mable',
    })
    // The key is the host session id, so a retry of THIS birth collapses.
    expect(fact?.idempotencyKey).toBe('hsid-born-1')
    expect(fact?.summary).toContain('clod born at hrc-runtime:T-08389 on max3 via summon')
  })

  it('classifies a successor as session.rotated and names its prior generation', () => {
    const fact = deriveSessionProjectEvent({
      session: sessionRecord({
        hostSessionId: 'hsid-gen-18',
        generation: 18,
        priorHostSessionId: 'hsid-gen-17',
        scopeRef: 'agent:clod:project:hrc-runtime:task:primary',
      }),
      payload: { created: true, priorHostSessionId: 'hsid-gen-17' },
      node: NODE,
      occurredAt: OCCURRED,
    })

    expect(fact?.type).toBe('session.rotated')
    expect(fact?.attributes['cause']).toBe('rotation')
    expect(fact?.attributes['prior_session']).toBe('hsid-gen-17')
    expect(fact?.attributes['generation']).toBe('18')
    // A different host session id, so a rotation never collapses onto its prior.
    expect(fact?.idempotencyKey).toBe('hsid-gen-18')
  })

  it('maps every birth door onto the declared cause vocabulary', () => {
    const cause = (payload: Record<string, unknown>): string | undefined =>
      deriveSessionProjectEvent({
        session: sessionRecord(),
        payload,
        node: NODE,
        occurredAt: OCCURRED,
      })?.attributes['cause']

    expect(cause({ created: true, summon: true })).toBe('summon')
    expect(cause({ created: true, reason: 'exact-scope-claim' })).toBe('dispatch')
    expect(cause({ created: true, reason: 'roster-suffix-claim' })).toBe('dispatch')
    expect(cause({ created: true, reason: 'codex-desktop-registration' })).toBe('desktop')
    expect(cause({ created: true, commandRun: true })).toBe('command_run')
    expect(cause({ created: true })).toBe('resolve')
  })

  it('drops a scope with no project, which has no timeline to land on', () => {
    expect(
      deriveSessionProjectEvent({
        session: sessionRecord({ scopeRef: 'agent:clod' }),
        payload: { created: true },
        node: NODE,
        occurredAt: OCCURRED,
      })
    ).toBeUndefined()
  })

  it('publishes the birth without harness facts rather than guessing them', () => {
    const fact = deriveSessionProjectEvent({
      session: sessionRecord({ lastAppliedIntentJson: undefined }),
      payload: { created: true },
      node: NODE,
      occurredAt: OCCURRED,
    })
    expect(Object.keys(fact?.attributes ?? {})).not.toContain('harness')
    expect(Object.keys(fact?.attributes ?? {})).not.toContain('mode')
    expect(fact?.attributes['seat']).toBe('agent:clod:project:hrc-runtime:task:T-08389')
  })
})

describe('T-08389 — affiliation', () => {
  it('attempts --task only for a canonical T-\\d{5} with no suffix', () => {
    expect(taskSelectorFrom('T-08389')).toBe('T-08389')
    // The measured ~7%: probe suffixes, e2e variants, malformed ids.
    expect(taskSelectorFrom('T-08199:role:parallel-alpha')).toBeUndefined()
    expect(taskSelectorFrom('T-08199-e2e')).toBeUndefined()
    expect(taskSelectorFrom('T-8151')).toBeUndefined()
    // The further ~46%: non-T selectors.
    expect(taskSelectorFrom('primary')).toBeUndefined()
    expect(taskSelectorFrom('minisvc')).toBeUndefined()
    expect(taskSelectorFrom(undefined)).toBeUndefined()
  })

  it('never sends project and task together, and keeps the full selector in seat', () => {
    const probe = deriveSessionProjectEvent({
      session: sessionRecord({
        scopeRef: 'agent:clod:project:hrc-runtime:task:T-08199:role:parallel-alpha',
      }),
      payload: { created: true },
      node: NODE,
      occurredAt: OCCURRED,
    })
    expect(probe?.task).toBeUndefined()
    expect(probe?.attributes['seat']).toBe(
      'agent:clod:project:hrc-runtime:task:T-08199:role:parallel-alpha'
    )

    const canonical = deriveSessionProjectEvent({
      session: sessionRecord(),
      payload: { created: true },
      node: NODE,
      occurredAt: OCCURRED,
    })
    const attempts = postParamsFor(canonical!)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({ task: 'T-08389' })
    expect(attempts[0]?.project).toBeUndefined()
    expect(attempts[1]).toMatchObject({ project: 'hrc-runtime' })
    expect(attempts[1]?.task).toBeUndefined()
  })
})

describe('T-08389 — the daemon posts a real birth', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined
  let ledger: FakeWrkqLedger

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t08389-')
    ledger = new FakeWrkqLedger()
  })

  afterEach(async () => {
    if (server !== undefined) {
      await server.stop()
      server = undefined
    }
    await fixture.cleanup()
  })

  async function startServer(): Promise<HrcServer> {
    server = await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false, wrkqLedger: ledger })
    )
    return server
  }

  it('threads a task-scoped birth under its task and a :primary birth at project level', async () => {
    const instance = await startServer()

    await fixture.resolveSession('agent:clod:project:hrc-runtime:task:T-08389')
    await fixture.resolveSession('agent:clod:project:hrc-runtime:task:primary')
    await instance.sessionProjectEvents.drain()

    const posts = ledger.projectEventPosts
    expect(posts).toHaveLength(2)

    const scoped = posts.find((post) => post.attributes['seat']?.endsWith(':task:T-08389'))
    expect(scoped?.type).toBe('session.born')
    expect(scoped?.task).toBe('T-08389')
    expect(scoped?.project).toBeUndefined()

    const primary = posts.find((post) => post.attributes['seat']?.endsWith(':task:primary'))
    expect(primary?.type).toBe('session.born')
    expect(primary?.project).toBe('hrc-runtime')
    expect(primary?.task).toBeUndefined()
  })

  it('falls back to the project when wrkq cannot resolve the task, instead of dropping the birth', async () => {
    const instance = await startServer()
    ledger.unresolvableTasks.add('T-08340')

    await fixture.resolveSession('agent:clod:project:hrc-runtime:task:T-08340')
    await instance.sessionProjectEvents.drain()

    const posts = ledger.projectEventPosts
    expect(posts).toHaveLength(2)
    expect(posts[0]).toMatchObject({ task: 'T-08340' })
    expect(posts[1]).toMatchObject({ project: 'hrc-runtime' })
    // The birth survives, and the selector wrkq could not resolve survives with it.
    expect(posts[1]?.attributes['seat']).toBe('agent:clod:project:hrc-runtime:task:T-08340')
  })

  it('reaches no ledger at all unless one is passed, so an embedded server cannot write to the fleet', async () => {
    // An in-process server resolves the same wrkq locator as the node's daemon:
    // the ledger's address lives in the environment, not in the runtime/state
    // roots a test isolates. This producer turned that latent exposure into 25
    // fabricated `session.born` rows in the LIVE hrc-runtime timeline before the
    // default was inverted. `hrc server serve` passes the real client; a server
    // built without one must be unable to reach shared state.
    server = await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false, wrkqLedger: undefined })
    )

    await fixture.resolveSession('agent:clod:project:hrc-runtime:task:T-08389')
    await server.sessionProjectEvents.drain()

    await expect(
      server.wrkqLedger.projectEventPost({
        project: 'hrc-runtime',
        type: 'session.born',
        summary: 'must never reach the fleet ledger',
        attributes: { source: 'hrc-server' },
      })
    ).rejects.toThrow(/not wired to this server/)
  })

  it('does not let an unreachable ledger reach the birth it is observing', async () => {
    const instance = await startServer()
    ledger.unavailable = true

    const resolved = await fixture.resolveSession('agent:clod:project:hrc-runtime:task:T-08389')
    await instance.sessionProjectEvents.drain()

    expect(resolved.hostSessionId).toBeTruthy()
    expect(instance.db.sessions.getByHostSessionId(resolved.hostSessionId)?.scopeRef).toBe(
      'agent:clod:project:hrc-runtime:task:T-08389'
    )
  })
})
