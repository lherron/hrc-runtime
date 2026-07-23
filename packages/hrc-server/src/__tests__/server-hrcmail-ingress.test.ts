import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  HRC_MAIL_REPLY_SCHEMA_DIALECT,
  type HrcMailAckResponse,
  type HrcMailInboxResponse,
  type HrcMailSendRequest,
  type HrcMailSendResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const target = 'agent:cody:project:hrc-runtime:task:T-06810/lane:main'
const sender = 'agent:mable:project:hrc-runtime:task:T-06810/lane:main'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-mail-ingress-')
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

function sendRequest(ingressId: string): HrcMailSendRequest {
  return {
    ingressId,
    from: { kind: 'scope', sessionRef: sender },
    targetSessionRef: target,
    payload: {
      kind: 'request',
      body: 'return a structured answer',
      metadata: { campaign: 'T-06810' },
    },
    replySchema: {
      $schema: HRC_MAIL_REPLY_SCHEMA_DIALECT,
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    },
  }
}

describe('hrcmail Wave-1 daemon surface', () => {
  it('send persists an envelope + stable receipt with zero session/runtime creation', async () => {
    const firstResponse = await fixture.postJson('/v1/mail/send', sendRequest('ingress-wire-1'))
    expect(firstResponse.status).toBe(200)
    const first = (await firstResponse.json()) as HrcMailSendResponse
    expect(first.envelope.state).toBe('pending')
    expect(first.receipt.envelopeId).toBe(first.envelope.envelopeId)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.mailEnvelopes.require(first.envelope.envelopeId)).toEqual(first.envelope)
      for (const table of ['sessions', 'runtimes', 'runs'] as const) {
        const row = db.sqlite
          .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
          .get()
        expect(row?.count).toBe(0)
      }
    } finally {
      db.close()
    }

    const retryResponse = await fixture.postJson('/v1/mail/send', sendRequest('ingress-wire-1'))
    expect(retryResponse.status).toBe(200)
    expect((await retryResponse.json()) as HrcMailSendResponse).toEqual(first)
  })

  it('inbox exposes stable ids and schemas while typed reply failure remains unacked', async () => {
    const sendResponse = await fixture.postJson('/v1/mail/send', sendRequest('ingress-wire-2'))
    const sent = (await sendResponse.json()) as HrcMailSendResponse

    const inboxResponse = await fixture.postJson('/v1/mail/inbox', {
      actor: { kind: 'scope', sessionRef: target },
      targetSessionRef: target,
    })
    expect(inboxResponse.status).toBe(200)
    const inbox = (await inboxResponse.json()) as HrcMailInboxResponse
    expect(inbox.envelopes[0]?.envelopeId).toBe(sent.envelope.envelopeId)
    expect(inbox.envelopes[0]?.replySchema).toBeDefined()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.mailEnvelopes.presentPendingForTarget(target)
    } finally {
      db.close()
    }

    const invalid = await fixture.postJson('/v1/mail/ack', {
      actor: { kind: 'scope', sessionRef: target },
      envelopeIds: [sent.envelope.envelopeId],
      response: { ok: 'not-a-boolean' },
    })
    expect(invalid.status).toBe(400)

    const afterInvalid = openHrcDatabase(fixture.dbPath)
    try {
      expect(afterInvalid.mailEnvelopes.require(sent.envelope.envelopeId).state).toBe('presented')
    } finally {
      afterInvalid.close()
    }

    const valid = await fixture.postJson('/v1/mail/ack', {
      actor: { kind: 'scope', sessionRef: target },
      envelopeIds: [sent.envelope.envelopeId],
      response: { ok: true },
    })
    expect(valid.status).toBe(200)
    const acked = (await valid.json()) as HrcMailAckResponse
    expect(acked.results[0]?.envelope.state).toBe('acked')
  })

  it('refuses a mismatched scope disposition and invalid remote schemas visibly', async () => {
    const sendResponse = await fixture.postJson('/v1/mail/send', sendRequest('ingress-wire-3'))
    const sent = (await sendResponse.json()) as HrcMailSendResponse
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.mailEnvelopes.presentPendingForTarget(target)
    } finally {
      db.close()
    }

    const mismatched = await fixture.postJson('/v1/mail/ack', {
      actor: {
        kind: 'scope',
        sessionRef: 'agent:clod:project:hrc-runtime:task:T-06810/lane:main',
      },
      envelopeIds: [sent.envelope.envelopeId],
      response: { ok: true },
    })
    expect(mismatched.status).toBe(409)
    expect(await mismatched.text()).toContain('target_mismatch')

    const remoteSchema = sendRequest('ingress-wire-remote-schema')
    remoteSchema.replySchema = { $ref: 'https://example.test/reply.json' }
    const rejected = await fixture.postJson('/v1/mail/send', remoteSchema)
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toContain('remote references')
  })
})
