import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HRC_MAIL_REPLY_SCHEMA_DIALECT,
  HRC_MAIL_REPLY_SCHEMA_MAX_BYTES,
  type HrcMailActor,
} from 'hrc-core'

import { HrcMailRepositoryError, openHrcDatabase } from '../index.js'
import type { HrcDatabase } from '../index.js'

const target = 'agent:cody:project:hrc-runtime:task:T-06810/lane:main'
const sender: HrcMailActor = {
  kind: 'scope',
  sessionRef: 'agent:mable:project:hrc-runtime:task:T-06810/lane:main',
}
const targetActor: HrcMailActor = { kind: 'scope', sessionRef: target }
const wrongActor: HrcMailActor = {
  kind: 'scope',
  sessionRef: 'agent:clod:project:hrc-runtime:task:T-06810/lane:main',
}
const operator: HrcMailActor = { kind: 'operator', principal: 'local-operator' }

let tmpDir: string
let db: HrcDatabase

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-mail-test-'))
  db = openHrcDatabase(join(tmpDir, 'state.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

function send(
  ingressId: string,
  options: {
    body?: string
    kind?: 'request' | 'conversational'
    replySchema?: Record<string, unknown>
  } = {}
) {
  return db.mailEnvelopes.create({
    ingressId,
    from: sender,
    targetSessionRef: target,
    payload: {
      kind: options.kind ?? 'request',
      body: options.body ?? 'please respond',
      metadata: { taskId: 'T-06810' },
    },
    ...(options.replySchema === undefined ? {} : { replySchema: options.replySchema }),
  })
}

describe('HrcMailEnvelopeRepository', () => {
  it('persists one stable receipt for an idempotent ingress and refuses conflicting reuse', () => {
    const first = send('ingress-1')
    const retried = send('ingress-1')

    expect(retried).toEqual(first)
    expect(first.receipt.path).toBe('mail')
    expect(first.envelope.state).toBe('pending')
    expect(first.envelope.roundCount).toBe(0)
    expect(db.mailEnvelopes.getIngressReceipt('ingress-1')).toEqual(first.receipt)

    expect(() => send('ingress-1', { body: 'different' })).toThrow(HrcMailRepositoryError)
    expect(db.mailEnvelopes.list()).toHaveLength(1)
  })

  it('can persist a v1-inline path receipt without manufacturing an envelope', () => {
    const receipt = {
      ingressId: 'pre-cutover-ingress',
      envelopeId: 'mail-pre-cutover-stable-id',
      path: 'v1_inline',
      createdAt: new Date().toISOString(),
    } as const
    db.sqlite
      .query(
        `INSERT INTO hrcmail_ingress_receipts (
          ingress_id, path_choice, envelope_id, request_fingerprint, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        receipt.ingressId,
        receipt.path,
        receipt.envelopeId,
        'pre-cutover-fingerprint',
        JSON.stringify(receipt),
        receipt.createdAt
      )

    expect(db.mailEnvelopes.getIngressReceipt(receipt.ingressId)).toEqual(receipt)
    expect(db.mailEnvelopes.get(receipt.envelopeId)).toBeUndefined()
  })

  it('enforces pending -> presented -> acked and idempotent terminal CAS semantics', () => {
    const sent = send('ingress-ack')
    expect(() =>
      db.mailEnvelopes.ack({
        actor: targetActor,
        envelopeIds: [sent.envelope.envelopeId],
      })
    ).toThrow('cannot acknowledge pending envelope')

    const [presented] = db.mailEnvelopes.presentPendingForTarget(target)
    expect(presented?.state).toBe('presented')
    // Presentation alone is not a round. The kicker records a round only when
    // its turn ends without ack/defer; a clear or in-progress turn must not
    // consume the dead-letter budget.
    expect(presented?.roundCount).toBe(0)

    const [acked] = db.mailEnvelopes.ack({
      actor: targetActor,
      envelopeIds: [sent.envelope.envelopeId],
      response: 'done',
    })
    expect(acked?.outcome).toBe('applied')
    expect(acked?.envelope.state).toBe('acked')
    expect(acked?.envelope.response).toBe('done')

    const [retried] = db.mailEnvelopes.ack({
      actor: targetActor,
      envelopeIds: [sent.envelope.envelopeId],
      response: 'done',
    })
    expect(retried?.outcome).toBe('idempotent')

    expect(() =>
      db.mailEnvelopes.ack({
        actor: targetActor,
        envelopeIds: [sent.envelope.envelopeId],
        response: 'different',
      })
    ).toThrow('already acknowledged with a different response')
  })

  it('refuses target mismatch while allowing an operator principal', () => {
    const first = send('ingress-authority-1')
    db.mailEnvelopes.presentPendingForTarget(target)

    expect(() =>
      db.mailEnvelopes.ack({
        actor: wrongActor,
        envelopeIds: [first.envelope.envelopeId],
      })
    ).toThrow('targets')
    expect(db.mailEnvelopes.require(first.envelope.envelopeId).state).toBe('presented')

    const [acked] = db.mailEnvelopes.ack({
      actor: operator,
      envelopeIds: [first.envelope.envelopeId],
    })
    expect(acked?.envelope.state).toBe('acked')

    expect(() => db.mailEnvelopes.inbox(wrongActor, target)).toThrow('cannot be read')
    expect(db.mailEnvelopes.inbox(operator, target)).toEqual([])
  })

  it('validates a Draft 2020-12 reply before accepting ack and leaves failures unacked', () => {
    const sent = send('ingress-schema', {
      replySchema: {
        $schema: HRC_MAIL_REPLY_SCHEMA_DIALECT,
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: {
          status: { const: 'ok' },
        },
      },
    })
    db.mailEnvelopes.presentPendingForTarget(target)

    expect(() =>
      db.mailEnvelopes.ack({
        actor: targetActor,
        envelopeIds: [sent.envelope.envelopeId],
      })
    ).toThrow('requires a response')
    expect(() =>
      db.mailEnvelopes.ack({
        actor: targetActor,
        envelopeIds: [sent.envelope.envelopeId],
        response: { status: 'wrong' },
      })
    ).toThrow('does not satisfy')
    expect(db.mailEnvelopes.require(sent.envelope.envelopeId).state).toBe('presented')

    const [acked] = db.mailEnvelopes.ack({
      actor: targetActor,
      envelopeIds: [sent.envelope.envelopeId],
      response: { status: 'ok' },
    })
    expect(acked?.envelope.state).toBe('acked')
    expect(acked?.envelope.response).toEqual({ status: 'ok' })
  })

  it('rejects remote refs, another dialect, oversized schemas, and schema-bound batches', () => {
    expect(() =>
      send('ingress-remote-ref', {
        replySchema: {
          $schema: HRC_MAIL_REPLY_SCHEMA_DIALECT,
          $ref: 'https://example.test/schema.json',
        },
      })
    ).toThrow('remote references')
    expect(() =>
      send('ingress-wrong-dialect', {
        replySchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'string',
        },
      })
    ).toThrow('dialect must be')
    expect(() =>
      send('ingress-oversized', {
        replySchema: {
          $schema: HRC_MAIL_REPLY_SCHEMA_DIALECT,
          description: 'x'.repeat(HRC_MAIL_REPLY_SCHEMA_MAX_BYTES),
        },
      })
    ).toThrow('maximum is')

    const schemaBound = send('ingress-batch-schema', {
      replySchema: { type: 'string' },
    })
    const plain = send('ingress-batch-plain')
    db.mailEnvelopes.presentPendingForTarget(target)
    expect(() =>
      db.mailEnvelopes.ack({
        actor: targetActor,
        envelopeIds: [schemaBound.envelope.envelopeId, plain.envelope.envelopeId],
        response: 'ok',
      })
    ).toThrow('one at a time')
    expect(db.mailEnvelopes.require(plain.envelope.envelopeId).state).toBe('presented')
  })

  it('supports presented -> deferred -> acked and durable retry requeue', () => {
    const directAck = send('ingress-defer-ack')
    const requeue = send('ingress-defer-requeue')
    db.mailEnvelopes.presentPendingForTarget(target)

    const deferred = db.mailEnvelopes.defer({
      actor: targetActor,
      envelopeId: directAck.envelope.envelopeId,
      reason: 'waiting on dependency',
    })
    expect(deferred.envelope.state).toBe('deferred')
    const acked = db.mailEnvelopes.ack({
      actor: targetActor,
      envelopeIds: [directAck.envelope.envelopeId],
      response: 'dependency arrived',
    })
    expect(acked[0]?.envelope.state).toBe('acked')

    db.mailEnvelopes.defer({
      actor: targetActor,
      envelopeId: requeue.envelope.envelopeId,
      reason: 'durable backstop',
      retryAfterMs: 1,
    })
    const requeued = db.mailEnvelopes.requeueDeferredDue(
      new Date(Date.now() + 10_000).toISOString()
    )
    expect(requeued.map((envelope) => envelope.envelopeId)).toContain(requeue.envelope.envelopeId)
    expect(db.mailEnvelopes.require(requeue.envelope.envelopeId).state).toBe('pending')
  })

  it('auto-acks conversational envelopes on presentation and exposes dead letters', () => {
    const conversation = send('ingress-conversation', { kind: 'conversational' })
    const request = send('ingress-dead')
    const presented = db.mailEnvelopes.presentPendingForTarget(target)
    const autoAcked = presented.find(
      (envelope) => envelope.envelopeId === conversation.envelope.envelopeId
    )
    expect(autoAcked?.state).toBe('acked')

    const dead = db.mailEnvelopes.markDead(request.envelope.envelopeId)
    expect(dead.state).toBe('dead')
    expect(db.mailEnvelopes.list({ dead: true }).map((envelope) => envelope.envelopeId)).toEqual([
      request.envelope.envelopeId,
    ])
  })
})
