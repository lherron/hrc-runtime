import { describe, expect, test } from 'bun:test'

import type { BindingRegistry, BirthDesignationRecord, PlacementBinding } from 'hrc-store-sqlite'

import type { PeerEntry } from '../federation/federation-config.js'
import { PeerToken } from '../federation/peer-token.js'
import {
  HttpBindingRegistryClient,
  LocalBindingRegistryClient,
  type RegistryClientFetch,
  RegistryRefusedError,
  RegistryUnreachableError,
} from '../federation/registry-client.js'

/**
 * T-11802 — characterization of the registry client's observable surface,
 * pinned before the module was split into contract / local / http / reply /
 * attempt files: the exact request each route puts on the wire, how each route
 * maps statuses, which routes retry, and the log events each route emits.
 */

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-11802'
const TOKEN = 'registry-characterization-secret'
const ORIGIN = 'http://svc.example.ts.net:18491'
const BINDING: PlacementBinding = {
  scopeRef: SCOPE,
  homeNodeId: 'lab',
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
}
const DESIGNATION: BirthDesignationRecord = {
  scopeRef: SCOPE,
  homeNodeId: 'lab',
  provenance: 'default_home_node(sender)',
  birthEnvelopeId: 'EN-11802',
  senderScopeRef: 'agent:mable:project:hrc-runtime:task:primary',
  designationEpoch: 2,
  designatedAt: '2026-10-24T00:00:00.000Z',
  state: 'live',
}
const ESTABLISH = { scopeRef: SCOPE, homeNodeId: 'lab', now: '2026-10-24T00:00:00.000Z' }
const DELETE = { scopeRef: SCOPE, expectedHomeNodeId: 'lab', retiredAt: '2026-10-24T00:00:00.000Z' }

type LogLine = [level: string, event: string, details: Record<string, unknown> | undefined]
type Reply = Response | Error

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function connectRefused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
}

/** A client whose transport replays `replies` in order (the last one repeats). */
function harness(replies: Reply[], options: { random?: number } = {}) {
  const requests: { url: string; init: RequestInit }[] = []
  const logs: LogLine[] = []
  const sleeps: { ms: number; signal: AbortSignal | undefined }[] = []
  const fetch: RegistryClientFetch = (url, init) => {
    requests.push({ url, init })
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply!.clone())
  }
  const client = new HttpBindingRegistryClient(
    {
      nodeId: 'svc' as PeerEntry['nodeId'],
      endpoint: ORIGIN,
      token: new PeerToken(TOKEN),
    },
    {
      fetch,
      perAttemptTimeoutMs: 50,
      totalTimeoutMs: 500,
      now: () => 0,
      random: () => options.random ?? 0,
      sleep: async (ms, signal) => {
        sleeps.push({ ms, signal })
      },
      log: (level, event, details) => logs.push([level, event, details]),
    }
  )
  return { client, requests, logs, sleeps }
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error
  )
}

describe('T-11802 HTTP request wire per route', () => {
  const authorization = `Bearer ${TOKEN}`
  const jsonHeaders = { authorization, 'content-type': 'application/json' }

  test.each([
    {
      route: 'consult',
      call: (c: HttpBindingRegistryClient) => c.consult(SCOPE),
      reply: json({ ok: true, binding: BINDING }),
      url: `${ORIGIN}/v1/federation/registry/consult?scopeRef=${encodeURIComponent(SCOPE)}`,
      method: 'GET',
      headers: { authorization },
      body: undefined,
    },
    {
      route: 'establish',
      call: (c: HttpBindingRegistryClient) => c.establish(ESTABLISH),
      reply: json({ ok: true, outcome: 'created', binding: BINDING }),
      url: `${ORIGIN}/v1/federation/registry/establish`,
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(ESTABLISH),
    },
    {
      route: 'designateBirth',
      call: (c: HttpBindingRegistryClient) => c.designateBirth(SCOPE),
      reply: json({ kind: 'none' }),
      url: `${ORIGIN}/v1/federation/registry/designate-birth`,
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ scopeRef: SCOPE }),
    },
    {
      route: 'listUnbornDesignations',
      call: (c: HttpBindingRegistryClient) => c.listUnbornDesignations('svc'),
      reply: json({ designations: [] }),
      url: `${ORIGIN}/v1/federation/registry/unborn-designations?homeNodeId=svc`,
      method: 'GET',
      headers: { authorization },
      body: undefined,
    },
    {
      route: 'readDesignation',
      call: (c: HttpBindingRegistryClient) => c.readDesignation(SCOPE),
      reply: json({ outcome: 'none' }),
      url: `${ORIGIN}/v1/federation/registry/designation?scopeRef=${encodeURIComponent(SCOPE)}`,
      method: 'GET',
      headers: { authorization },
      body: undefined,
    },
    {
      route: 'deleteBinding',
      call: (c: HttpBindingRegistryClient) => c.deleteBinding(DELETE),
      reply: json({ outcome: 'idempotent' }, 404),
      url: `${ORIGIN}/v1/federation/registry/delete`,
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(DELETE),
    },
  ])('$route sends exactly one $method with plain-object headers', async (row) => {
    const { client, requests } = harness([row.reply])
    await row.call(client)

    expect(requests).toHaveLength(1)
    const [{ url, init }] = requests as [{ url: string; init: RequestInit }]
    expect(url).toBe(row.url)
    expect(init.method).toBe(row.method)
    expect(init.headers).toEqual(row.headers)
    expect(init.body).toBe(row.body)
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('T-11802 HTTP reply mapping per route', () => {
  test.each([
    [
      'designated',
      json({ kind: 'designated', designation: DESIGNATION }),
      { kind: 'designated', designation: DESIGNATION },
    ],
    ['none', json({ kind: 'none' }), { kind: 'none' }],
    ['pre-route 404', json({ ok: false }, 404), { kind: 'none' }],
  ] as const)('designateBirth maps %s', async (_name, reply, expected) => {
    expect(await harness([reply]).client.designateBirth(SCOPE)).toEqual(expected)
  })

  test.each([
    ['unknown provenance', { ...DESIGNATION, provenance: 'explicit' }],
    ['another scope', { ...DESIGNATION, scopeRef: `${SCOPE}-other` }],
    ['epoch zero', { ...DESIGNATION, designationEpoch: 0 }],
  ])('designateBirth fails closed on a designation with %s', async (_name, designation) => {
    const error = await failure(
      harness([json({ kind: 'designated', designation })]).client.designateBirth(SCOPE)
    )
    expect(error).toBeInstanceOf(RegistryUnreachableError)
  })

  test('readDesignation keeps a known supersession source and drops an unknown one', async () => {
    const superseded = {
      ...DESIGNATION,
      state: 'superseded',
      supersededBy: 'pin',
      supersededAt: '2026-10-24T01:00:00.000Z',
    }
    expect(
      await harness([
        json({ outcome: 'superseded', designation: superseded }),
      ]).client.readDesignation(SCOPE)
    ).toEqual({ outcome: 'superseded', designation: superseded as BirthDesignationRecord })

    const { supersededBy: _dropped, ...withoutSource } = superseded
    expect(
      await harness([
        json({ outcome: 'superseded', designation: { ...superseded, supersededBy: 'gossip' } }),
      ]).client.readDesignation(SCOPE)
    ).toEqual({ outcome: 'superseded', designation: withoutSource as BirthDesignationRecord })
  })

  test('readDesignation answers none for an older host', async () => {
    expect(await harness([json({}, 404)]).client.readDesignation(SCOPE)).toEqual({
      outcome: 'none',
    })
  })

  test.each([
    [
      'deleted',
      200,
      { outcome: 'deleted', binding: BINDING },
      { outcome: 'deleted', binding: BINDING },
    ],
    [
      'conflict',
      409,
      { outcome: 'conflict', binding: BINDING },
      { outcome: 'conflict', binding: BINDING },
    ],
    ['idempotent', 404, { outcome: 'idempotent' }, { outcome: 'idempotent' }],
    [
      'unparseable binding',
      200,
      { outcome: 'deleted', binding: { scopeRef: SCOPE } },
      { outcome: 'deleted' },
    ],
  ] as const)('deleteBinding maps %s', async (_name, status, body, expected) => {
    expect(await harness([json(body, status)]).client.deleteBinding(DELETE)).toEqual(expected)
  })

  test.each([
    ['unknown outcome', json({ outcome: 'gone' })],
    ['no outcome', json({ binding: BINDING })],
    ['unexpected status', json({ outcome: 'deleted' }, 500)],
    ['unreadable body', new Response('not json', { status: 200 })],
  ])('deleteBinding fails closed on %s', async (_name, reply) => {
    expect(await failure(harness([reply]).client.deleteBinding(DELETE))).toBeInstanceOf(
      RegistryUnreachableError
    )
  })

  test('establish fails closed on an outcome it does not know', async () => {
    const error = await failure(
      harness([
        json({ ok: true, outcome: 'designation-mismatch', binding: BINDING }),
      ]).client.establish(ESTABLISH)
    )
    expect(error).toBeInstanceOf(RegistryUnreachableError)
  })

  test.each([
    ['consult', (c: HttpBindingRegistryClient) => c.consult(SCOPE)],
    ['establish', (c: HttpBindingRegistryClient) => c.establish(ESTABLISH)],
    ['designateBirth', (c: HttpBindingRegistryClient) => c.designateBirth(SCOPE)],
    ['listUnbornDesignations', (c: HttpBindingRegistryClient) => c.listUnbornDesignations('svc')],
    ['readDesignation', (c: HttpBindingRegistryClient) => c.readDesignation(SCOPE)],
    ['deleteBinding', (c: HttpBindingRegistryClient) => c.deleteBinding(DELETE)],
  ])(
    '%s refuses a 403 as authenticated_node_mismatch on the first attempt',
    async (_name, call) => {
      const { client, requests } = harness([json({}, 403)])
      const error = await failure(call(client))
      expect(error).toBeInstanceOf(RegistryRefusedError)
      expect(error).toMatchObject({
        status: 403,
        code: 'authenticated_node_mismatch',
        retryable: false,
      })
      expect(requests).toHaveLength(1)
    }
  )
})

describe('T-11802 HTTP retry posture per route', () => {
  test.each([
    ['consult', (c: HttpBindingRegistryClient) => c.consult(SCOPE), 3],
    ['designateBirth', (c: HttpBindingRegistryClient) => c.designateBirth(SCOPE), 3],
    ['establish', (c: HttpBindingRegistryClient) => c.establish(ESTABLISH), 1],
    [
      'listUnbornDesignations',
      (c: HttpBindingRegistryClient) => c.listUnbornDesignations('svc'),
      1,
    ],
    ['readDesignation', (c: HttpBindingRegistryClient) => c.readDesignation(SCOPE), 1],
    ['deleteBinding', (c: HttpBindingRegistryClient) => c.deleteBinding(DELETE), 1],
  ])('%s attempts a post-send 5xx %i time(s)', async (_name, call, attempts) => {
    const { client, requests } = harness([json({}, 500)])
    expect(await failure(call(client))).toBeInstanceOf(RegistryUnreachableError)
    expect(requests).toHaveLength(attempts)
  })

  test('designateBirth treats a 503 wrkq outage as retryable, never as none', async () => {
    const { client, requests } = harness([json({}, 503), json({ kind: 'none' })])
    expect(await client.designateBirth(SCOPE)).toEqual({ kind: 'none' })
    expect(requests).toHaveLength(2)
  })

  test('backoff doubles a jittered ceiling and hands the caller signal to sleep', async () => {
    const caller = new AbortController()
    const { client, sleeps } = harness([connectRefused()], { random: 0.5 })
    await failure(client.consult(SCOPE, { signal: caller.signal }))
    expect(sleeps).toEqual([
      { ms: 187.5, signal: caller.signal },
      { ms: 375, signal: caller.signal },
    ])

    const establish = harness([connectRefused()], { random: 1 })
    await failure(establish.client.establish(ESTABLISH))
    expect(establish.sleeps).toEqual([
      { ms: 250, signal: undefined },
      { ms: 500, signal: undefined },
    ])
  })
})

describe('T-11802 HTTP request logging per route', () => {
  test('consult logs every attempt, each retry, and the outcome', async () => {
    const { client, logs } = harness([connectRefused(), json({ ok: true, binding: BINDING })])
    await client.consult(SCOPE)
    expect(logs).toEqual([
      [
        'INFO',
        'federation.registry.consult.attempt',
        { scopeRef: SCOPE, attempt: 1, maxAttempts: 3 },
      ],
      [
        'WARN',
        'federation.registry.consult.retry',
        { scopeRef: SCOPE, attempt: 1, nextAttempt: 2, retryable: true },
      ],
      [
        'INFO',
        'federation.registry.consult.attempt',
        { scopeRef: SCOPE, attempt: 2, maxAttempts: 3 },
      ],
      [
        'INFO',
        'federation.registry.consult.bound',
        { scopeRef: SCOPE, attempt: 2, homeNodeId: 'lab' },
      ],
    ])
  })

  test('consult logs a refusal and an exhausted budget', async () => {
    const refused = harness([json({}, 401)])
    await failure(refused.client.consult(SCOPE))
    expect(refused.logs.at(-1)).toEqual([
      'ERROR',
      'federation.registry.consult.refused',
      { scopeRef: SCOPE, attempt: 1, status: 401, code: 'unauthorized', retryable: false },
    ])

    const exhausted = harness([json({}, 500)])
    await failure(exhausted.client.consult(SCOPE))
    expect(exhausted.logs.map(([level, event]) => `${level} ${event}`)).toEqual([
      'INFO federation.registry.consult.attempt',
      'WARN federation.registry.consult.retry',
      'INFO federation.registry.consult.attempt',
      'WARN federation.registry.consult.retry',
      'INFO federation.registry.consult.attempt',
      'ERROR federation.registry.consult.unreachable',
    ])
    expect(exhausted.logs.at(-1)?.[2]).toEqual({ scopeRef: SCOPE, attempt: 3, retryable: true })
  })

  test('designateBirth logs only its outcome or its exhausted budget', async () => {
    const designated = harness([
      connectRefused(),
      json({ kind: 'designated', designation: DESIGNATION }),
    ])
    await designated.client.designateBirth(SCOPE)
    expect(designated.logs).toEqual([
      [
        'INFO',
        'federation.registry.designate_birth.designated',
        {
          scopeRef: SCOPE,
          attempt: 2,
          homeNodeId: 'lab',
          provenance: 'default_home_node(sender)',
          designationEpoch: 2,
          senderScopeRef: DESIGNATION.senderScopeRef,
        },
      ],
    ])

    const none = harness([json({ kind: 'none' })])
    await none.client.designateBirth(SCOPE)
    expect(none.logs).toEqual([
      ['INFO', 'federation.registry.designate_birth.none', { scopeRef: SCOPE, attempt: 1 }],
    ])

    const refused = harness([json({}, 400)])
    await failure(refused.client.designateBirth(SCOPE))
    expect(refused.logs).toEqual([])

    const exhausted = harness([json({}, 503)])
    await failure(exhausted.client.designateBirth(SCOPE))
    expect(exhausted.logs).toEqual([
      [
        'ERROR',
        'federation.registry.designate_birth.unreachable',
        { scopeRef: SCOPE, attempt: 3, retryable: true },
      ],
    ])
  })

  test.each([
    ['establish', (c: HttpBindingRegistryClient) => c.establish(ESTABLISH)],
    ['listUnbornDesignations', (c: HttpBindingRegistryClient) => c.listUnbornDesignations('svc')],
    ['readDesignation', (c: HttpBindingRegistryClient) => c.readDesignation(SCOPE)],
    ['deleteBinding', (c: HttpBindingRegistryClient) => c.deleteBinding(DELETE)],
  ])('%s logs nothing, on success or failure', async (_name, call) => {
    const { client, logs } = harness([connectRefused()])
    await failure(call(client))
    expect(logs).toEqual([])
  })
})

describe('T-11802 in-process host client', () => {
  function local(registry: Partial<BindingRegistry>) {
    const logs: LogLine[] = []
    const client = new LocalBindingRegistryClient(registry as BindingRegistry, 'lab', {
      log: (level, event, details) => logs.push([level, event, details]),
    })
    return { client, logs }
  }

  test('consult logs its transport and normalizes a registry fault', async () => {
    const bound = local({ get: () => BINDING })
    expect(await bound.client.consult(SCOPE)).toEqual({ outcome: 'bound', binding: BINDING })
    expect(bound.logs).toEqual([
      [
        'INFO',
        'federation.registry.consult.bound',
        { scopeRef: SCOPE, transport: 'local', homeNodeId: 'lab' },
      ],
    ])

    const fault = new Error('database is locked')
    const broken = local({
      get: () => {
        throw fault
      },
    })
    const error = await failure(broken.client.consult(SCOPE))
    expect(error).toBeInstanceOf(RegistryUnreachableError)
    expect((error as RegistryUnreachableError).cause).toBe(fault)
  })

  test('establish logs the designation a mismatch names', async () => {
    const { client, logs } = local({
      establish: () => ({ outcome: 'designation-mismatch', designation: DESIGNATION }),
    })
    await client.establish(ESTABLISH)
    expect(logs).toEqual([
      [
        'INFO',
        'federation.registry.establish.designation-mismatch',
        { scopeRef: SCOPE, designatedHomeNodeId: 'lab', designationEpoch: 2, transport: 'local' },
      ],
    ])
  })

  test.each([
    [
      'establish',
      (c: LocalBindingRegistryClient) => c.establish({ ...ESTABLISH, homeNodeId: 'svc' }),
    ],
    [
      'deleteBinding',
      (c: LocalBindingRegistryClient) => c.deleteBinding({ ...DELETE, expectedHomeNodeId: 'svc' }),
    ],
    ['listUnbornDesignations', (c: LocalBindingRegistryClient) => c.listUnbornDesignations('svc')],
    ['consult', (c: LocalBindingRegistryClient) => c.consult(' ')],
    ['designateBirth', (c: LocalBindingRegistryClient) => c.designateBirth('')],
    ['readDesignation', (c: LocalBindingRegistryClient) => c.readDesignation('')],
  ])('%s refuses a request for another node or no scope', async (_name, call) => {
    const error = await failure(call(local({}).client))
    expect(error).toBeInstanceOf(RegistryRefusedError)
    expect(error).toMatchObject({ status: 400, code: 'invalid_request' })
  })

  test('readDesignation reports a superseded record as superseded', async () => {
    const superseded = { ...DESIGNATION, state: 'superseded' as const }
    const { client } = local({ latestDesignation: () => superseded })
    expect(await client.readDesignation(SCOPE)).toEqual({
      outcome: 'superseded',
      designation: superseded,
    })
  })
})
