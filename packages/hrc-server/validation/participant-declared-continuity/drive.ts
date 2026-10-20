/**
 * T-11435 e2e: a direct participant declares `continuation: continue | fresh`
 * on register (R6.6 amendment, R7.3 fresh-start exception, §5.4 idempotency).
 *
 * Drives a REAL hrc-server over its unix socket: every register and attach is
 * an HTTP request to the daemon, and every predecessor is retired by the
 * daemon's own transport probe (the predecessor's broker socket does not
 * exist, so HRC observes it dead). The one store write is the stored
 * continuation itself, made through `sessions.updateContinuation`, the same
 * write the broker's `continuation.updated` projection performs.
 *
 *   bun drive.ts --socket <hrc.sock> --db <state.sqlite> --out <dir>
 *   bun drive.ts --socket <hrc.sock> --out <dir> --smoke
 *
 * `--smoke` needs no store access: fresh then continue against a scratch
 * address, for the installed live daemon. Each case writes
 * `<out>/case-<id>.json` (observed requests, responses and checks); the run
 * writes `<out>/summary.json` and exits 1 when any check failed.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { openHrcDatabase } from 'hrc-store-sqlite'
import {
  neutralParticipantBrokerDescriptorHash,
  neutralSpecHash,
  neutralStartRequestHash,
} from 'spaces-runtime-contracts'

import { makeParticipantBrokerDescriptor } from '../../src/__tests__/fixtures/participant-broker-descriptor.fixture.js'

type Json = Record<string, unknown>
type Predecessor = { hostIncarnationId: string; runtimeId: string; generation: number }
type Observed = { step: string; request: Json; httpStatus: number; body: Json }
type Check = { check: string; pass: boolean; observed: unknown; expected?: unknown }

const { values: args } = parseArgs({
  options: {
    socket: { type: 'string' },
    db: { type: 'string' },
    out: { type: 'string' },
    smoke: { type: 'boolean', default: false },
  },
})
if (args.socket === undefined || args.out === undefined || (!args.smoke && !args.db)) {
  console.error('usage: drive.ts --socket <hrc.sock> --out <dir> (--db <state.sqlite> | --smoke)')
  process.exit(2)
}
const SOCKET = args.socket
const OUT = args.out
const DB = args.db ?? ''
const RUN = new Date()
  .toISOString()
  .replace(/[-:.TZ]/g, '')
  .slice(0, 14)
mkdirSync(OUT, { recursive: true })

async function post(path: string, body: Json): Promise<{ httpStatus: number; body: Json }> {
  const response = await fetch(`http://localhost${path}`, {
    method: 'POST',
    unix: SOCKET,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { httpStatus: response.status, body: (await response.json()) as Json }
}

function withStore<T>(use: (db: ReturnType<typeof openHrcDatabase>) => T): T {
  const db = openHrcDatabase(DB, { migrate: false })
  try {
    return use(db)
  } finally {
    db.close()
  }
}

class Case {
  readonly steps: Observed[] = []
  readonly checks: Check[] = []
  constructor(
    readonly id: string,
    readonly title: string,
    readonly scope: string
  ) {}

  /** Incarnation ids are global (one incarnation holds one address), so they carry the scope. */
  host(name: string): string {
    return `${this.scope.split(':').at(-1)}-${name}`
  }

  async register(
    step: string,
    hostName: string,
    extra: { expectedPredecessor?: Predecessor; continuation?: unknown } = {}
  ): Promise<{ httpStatus: number; body: Json }> {
    const hostIncarnationId = this.host(hostName)
    const request: Json = {
      registrationMode: 'direct',
      requestedSessionRef: this.scope,
      hostIncarnationId,
      // The predecessor host is gone: nothing listens here, so HRC's own
      // transport probe observes it dead.
      socketPath: `/tmp/t11435-${RUN}-${this.id}-${hostIncarnationId}.sock`,
      ...(extra.expectedPredecessor === undefined
        ? {}
        : { expectedPredecessor: extra.expectedPredecessor }),
      ...(extra.continuation === undefined ? {} : { continuation: extra.continuation }),
    }
    const observed = await post('/v1/participants/register', request)
    this.steps.push({ step, request, ...observed })
    return observed
  }

  async attach(
    step: string,
    registered: Json,
    continuation?: unknown
  ): Promise<{ httpStatus: number; body: Json }> {
    const identity = registered['identity'] as Json | undefined
    if (identity === undefined) {
      const skipped = { httpStatus: 0, body: { status: 'not_attempted', registered } }
      this.steps.push({ step, request: {}, ...skipped })
      return skipped
    }
    const descriptor = makeParticipantBrokerDescriptor({
      requestId: identity['requestId'] as string,
      operationId: identity['operationId'] as string,
      hostSessionId: registered['hostSessionId'] as string,
      generation: registered['generation'] as number,
      runtimeId: identity['runtimeId'] as string,
      invocationId: identity['invocationId'] as string,
      cwd: '/tmp',
    })
    if (continuation !== undefined) {
      const invocation = descriptor.harnessInvocation
      invocation.startRequest.spec.continuation = continuation as never
      invocation.specHash = neutralSpecHash(invocation.startRequest.spec)
      invocation.startRequestHash = neutralStartRequestHash(invocation.startRequest)
      invocation.startRequest.spec.correlation.startRequestHash = invocation.startRequestHash
      descriptor.descriptorHash = neutralParticipantBrokerDescriptorHash(descriptor)
      invocation.startRequest.spec.correlation.selectedProfileHash = descriptor.descriptorHash
    }
    const request: Json = {
      registrationId: identity['registrationId'],
      attemptId: identity['attemptId'],
      attachEpoch: identity['attachEpoch'],
      socketPath: `/tmp/t11435-${RUN}-${this.id}-attach.sock`,
      descriptor,
    }
    const observed = await post('/v1/participants/attach', request)
    this.steps.push({ step, request: { ...request, descriptor: '<composed>' }, ...observed })
    return observed
  }

  seedContinuation(hostSessionId: string, continuation: Json): void {
    withStore((db) =>
      db.sessions.updateContinuation(hostSessionId, continuation as never, new Date().toISOString())
    )
    this.steps.push({
      step: `store: sessions.updateContinuation(${hostSessionId})`,
      request: continuation,
      httpStatus: 0,
      body: {},
    })
  }

  sessionContinuation(hostSessionId: string): unknown {
    return withStore((db) => db.sessions.getByHostSessionId(hostSessionId)?.continuation ?? null)
  }

  sessionCount(): number {
    return withStore((db) => db.sessions.listByScopeRef(this.scope).length)
  }

  expect(check: string, observed: unknown, expected: unknown): void {
    this.checks.push({
      check,
      pass: JSON.stringify(observed) === JSON.stringify(expected),
      observed,
      expected,
    })
  }

  write(): boolean {
    const pass = this.checks.length > 0 && this.checks.every((check) => check.pass)
    writeFileSync(
      join(OUT, `case-${this.id}.json`),
      `${JSON.stringify(
        {
          case: this.id,
          title: this.title,
          scope: this.scope,
          socket: SOCKET,
          pass,
          checks: this.checks,
          steps: this.steps,
        },
        null,
        2
      )}\n`
    )
    console.log(`${pass ? 'PASS' : 'FAIL'} case ${this.id}: ${this.title}`)
    for (const check of this.checks.filter((c) => !c.pass)) {
      console.log(`  x ${check.check}: ${JSON.stringify(check.observed)}`)
    }
    return pass
  }
}

function scopeFor(id: string): string {
  return `agent:t11435probe:project:hrc-runtime:task:T-11435-${id.toLowerCase()}-${RUN}`
}

function continuationOf(result: { body: Json }): unknown {
  const value = result.body['continuation'] as Json | undefined
  return value === undefined
    ? null
    : { carried: value['carried'], reason: value['reason'], selected: value['selected'] }
}

function predecessorOf(c: Case, result: { body: Json }, hostName: string): Predecessor {
  return {
    hostIncarnationId: c.host(hostName),
    runtimeId: (result.body['identity'] as Json)['runtimeId'] as string,
    generation: result.body['generation'] as number,
  }
}

/** An attached generation-1 host whose session has a stored continuation. */
async function predecessorWithContinuation(c: Case, stored: Json): Promise<Predecessor> {
  const first = await c.register('register host-a (first join)', 'host-a')
  c.expect('first join registered', first.body['status'], 'registered')
  const attached = await c.attach('attach host-a (no continuation)', first.body)
  c.expect('host-a attached', attached.body['status'], 'attached')
  c.seedContinuation(first.body['hostSessionId'] as string, stored)
  return predecessorOf(c, first, 'host-a')
}

async function caseFreshThenContinue(): Promise<boolean[]> {
  // A: fresh successor. D: a later continue carries what the fresh one stored.
  const a = new Case('A', 'fresh H2 over a stored continuation carries nothing', scopeFor('A'))
  const stored = { provider: 'openai', key: `thread-A-before-${RUN}` }
  const pred = await predecessorWithContinuation(a, stored)
  const predecessorSession = a.steps[0]?.body['hostSessionId'] as string
  const fresh = await a.register('register host-b fresh', 'host-b', {
    expectedPredecessor: pred,
    continuation: 'fresh',
  })
  a.expect('fresh registered', fresh.body['status'], 'registered')
  a.expect('fresh generation', fresh.body['generation'], 2)
  a.expect('fresh selection', continuationOf(fresh), {
    carried: false,
    reason: 'participant_fresh',
    selected: null,
  })
  a.expect('fresh resumed flag', fresh.body['resumed'], false)
  const smuggled = await a.attach('attach host-b WITH the old continuation', fresh.body, stored)
  a.expect(
    'control: carried continuation refused',
    smuggled.body['reason'],
    'participant_continuation_mismatch'
  )
  const attached = await a.attach('attach host-b with no continuation', fresh.body)
  a.expect('fresh attach accepted', attached.body['status'], 'attached')
  const freshSession = fresh.body['hostSessionId'] as string
  a.expect('fresh successor session has no continuation', a.sessionContinuation(freshSession), null)
  a.expect(
    'predecessor session still holds its continuation',
    a.sessionContinuation(predecessorSession),
    stored
  )
  const passA = a.write()

  const d = new Case('D', 'continue after a fresh successor carries the new record', a.scope)
  const renewed = { provider: 'openai', key: `thread-A-after-fresh-${RUN}` }
  d.seedContinuation(freshSession, renewed)
  const next = await d.register('register host-c continue', 'host-c', {
    expectedPredecessor: predecessorOf(d, fresh, 'host-b'),
    continuation: 'continue',
  })
  d.expect('continue registered', next.body['status'], 'registered')
  d.expect('continue generation', next.body['generation'], 3)
  d.expect('continue carries the fresh conversation record', continuationOf(next), {
    carried: true,
    reason: 'carried',
    selected: renewed,
  })
  const attachedNext = await d.attach('attach host-c with the new record', next.body, renewed)
  d.expect('continue attach accepted', attachedNext.body['status'], 'attached')
  d.expect(
    'generation-3 session carries the new record',
    d.sessionContinuation(next.body['hostSessionId'] as string),
    renewed
  )
  return [passA, d.write()]
}

async function caseCarried(id: 'B' | 'C', declaration: 'continue' | undefined): Promise<boolean> {
  const c = new Case(
    id,
    declaration === undefined
      ? 'omitted declaration carries the stored record (regression guard)'
      : 'continue H2 carries the stored record',
    scopeFor(id)
  )
  const stored = { provider: 'openai', key: `thread-${id}-before-${RUN}` }
  const pred = await predecessorWithContinuation(c, stored)
  const next = await c.register(
    `register host-b ${declaration ?? '(declaration omitted)'}`,
    'host-b',
    {
      expectedPredecessor: pred,
      ...(declaration === undefined ? {} : { continuation: declaration }),
    }
  )
  c.expect('registered', next.body['status'], 'registered')
  c.expect('generation', next.body['generation'], 2)
  c.expect('selection', continuationOf(next), {
    carried: true,
    reason: 'carried',
    selected: stored,
  })
  c.expect('resumed flag', next.body['resumed'], true)
  const attached = await c.attach(
    'attach host-b with exactly the selected record',
    next.body,
    stored
  )
  c.expect('attach accepted', attached.body['status'], 'attached')
  c.expect(
    'successor session carries the record',
    c.sessionContinuation(next.body['hostSessionId'] as string),
    stored
  )
  return c.write()
}

async function caseBogus(): Promise<boolean> {
  const c = new Case(
    'E',
    'an unknown declaration is a typed refusal that allocates nothing',
    scopeFor('E')
  )
  const pred = await predecessorWithContinuation(c, { provider: 'openai', key: `thread-E-${RUN}` })
  const before = c.sessionCount()
  const bogus = await c.register('register host-b continuation:bogus', 'host-b', {
    expectedPredecessor: pred,
    continuation: 'bogus',
  })
  c.expect('HTTP 400', bogus.httpStatus, 400)
  c.expect(
    'malformed request code',
    (bogus.body['error'] as Json | undefined)?.['code'],
    'malformed_request'
  )
  c.expect(
    'refused field',
    ((bogus.body['error'] as Json | undefined)?.['detail'] as Json | undefined)?.['field'],
    'continuation'
  )
  c.expect('no session allocated', c.sessionCount(), before)
  const control = await c.register('control: register host-b continue', 'host-b', {
    expectedPredecessor: pred,
    continuation: 'continue',
  })
  c.expect('control: same predecessor still free to succeed', control.body['generation'], 2)
  return c.write()
}

async function caseDeclarationIdentity(): Promise<boolean> {
  const c = new Case(
    'F',
    'a retry differing only in declaration is refused, never converged',
    scopeFor('F')
  )
  const stored = { provider: 'openai', key: `thread-F-${RUN}` }
  const pred = await predecessorWithContinuation(c, stored)
  const first = await c.register('register host-b continue', 'host-b', {
    expectedPredecessor: pred,
    continuation: 'continue',
  })
  c.expect('continue registered', continuationOf(first), {
    carried: true,
    reason: 'carried',
    selected: stored,
  })
  const sessionsAfterFirst = c.sessionCount()
  const flipped = await c.register('register host-b fresh, same predecessor', 'host-b', {
    expectedPredecessor: pred,
    continuation: 'fresh',
  })
  c.expect('flipped declaration status', flipped.body['status'], 'rejected')
  c.expect('flipped declaration reason', flipped.body['reason'], 'host_binding_precondition_failed')
  c.expect('flipped declaration HTTP', flipped.httpStatus, 409)
  c.expect('no second successor', c.sessionCount(), sessionsAfterFirst)
  const omitted = await c.register('control: retry with declaration omitted', 'host-b', {
    expectedPredecessor: pred,
  })
  c.expect(
    'control: omitted converges with continue (same identity)',
    omitted.body['identity'],
    first.body['identity']
  )
  c.expect('control: still one successor', c.sessionCount(), sessionsAfterFirst)
  return c.write()
}

async function caseFirstJoinFresh(): Promise<boolean> {
  const c = new Case('G', 'fresh on a first-ever join keeps no_continuation', scopeFor('G'))
  const first = await c.register('register host-a fresh (first join)', 'host-a', {
    continuation: 'fresh',
  })
  c.expect('registered', first.body['status'], 'registered')
  c.expect('selection', continuationOf(first), {
    carried: false,
    reason: 'no_continuation',
    selected: null,
  })
  return c.write()
}

async function smoke(): Promise<boolean> {
  const c = new Case(
    'smoke',
    'installed daemon: fresh then continue on a scratch address',
    scopeFor('smoke')
  )
  const first = await c.register('register host-a (first join)', 'host-a')
  c.expect('first join', continuationOf(first), {
    carried: false,
    reason: 'no_continuation',
    selected: null,
  })
  const fresh = await c.register('register host-b fresh', 'host-b', {
    expectedPredecessor: predecessorOf(c, first, 'host-a'),
    continuation: 'fresh',
  })
  c.expect('fresh generation', fresh.body['generation'], 2)
  c.expect('fresh selection', continuationOf(fresh), {
    carried: false,
    reason: 'participant_fresh',
    selected: null,
  })
  const next = await c.register('register host-c continue', 'host-c', {
    expectedPredecessor: predecessorOf(c, fresh, 'host-b'),
    continuation: 'continue',
  })
  c.expect('continue generation', next.body['generation'], 3)
  // The fresh generation stored nothing, so the automatic rule answers
  // no_continuation: `fresh` left no barrier behind it.
  c.expect('continue selection', continuationOf(next), {
    carried: false,
    reason: 'no_continuation',
    selected: null,
  })
  return c.write()
}

const results = args.smoke
  ? [await smoke()]
  : [
      ...(await caseFreshThenContinue()),
      await caseCarried('B', 'continue'),
      await caseCarried('C', undefined),
      await caseBogus(),
      await caseDeclarationIdentity(),
      await caseFirstJoinFresh(),
    ]
const pass = results.every(Boolean)
writeFileSync(
  join(OUT, 'summary.json'),
  `${JSON.stringify({ run: RUN, socket: SOCKET, smoke: args.smoke, pass, cases: results.length }, null, 2)}\n`
)
console.log(pass ? 'ALL PASS' : 'FAILURES')
process.exit(pass ? 0 : 1)
