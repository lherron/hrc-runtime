const [release, root] = process.argv.slice(2)
if (!root?.startsWith('/tmp/hrcp1-')) throw Error('scratch only')
const { openHrcDatabase } = await import(`${release}/packages/hrc-store-sqlite/src/index.ts`)
const db = openHrcDatabase(`${root}/state.sqlite`, { migrate: false })
const target = 'agent:tabularasa:project:hrc-runtime:task:p1-store'
const actor = { kind: 'operator', principal: 'fixture' }
const base = {
  ingressId: 'create-ingress',
  from: actor,
  targetSessionRef: ` ${target} `,
  payload: { kind: 'request', body: ' preserved body ', metadata: { b: 2, a: 1 } },
}
const result = []
function observe(name, fn) {
  try {
    result.push({ name, value: fn() })
  } catch (e) {
    result.push({
      name,
      error: { name: e.name, code: e.code, message: e.message, detail: e.detail },
    })
  }
}
try {
  observe('create', () => db.mailEnvelopes.create({ ...base, envelopeId: 'create-envelope' }))
  observe('repeat', () =>
    db.mailEnvelopes.create({
      ...base,
      envelopeId: 'ignored-id',
      materializationIntent: { first: true },
    })
  )
  observe('repeatHint', () =>
    db.mailEnvelopes.create({ ...base, materializationIntent: { second: true } })
  )
  observe('conflict', () =>
    db.mailEnvelopes.create({ ...base, payload: { ...base.payload, body: 'different' } })
  )
  observe('trimFingerprintConflict', () =>
    db.mailEnvelopes.create({ ...base, targetSessionRef: target })
  )
  observe('pendingAck', () => db.mailEnvelopes.ack({ actor, envelopeIds: ['create-envelope'] }))
  observe('present', () => db.mailEnvelopes.presentPendingForTarget(target))
  observe('wrongActor', () =>
    db.mailEnvelopes.ack({
      actor: { kind: 'scope', sessionRef: 'wrong' },
      envelopeIds: ['create-envelope'],
    })
  )
  observe('ack', () =>
    db.mailEnvelopes.ack({ actor, envelopeIds: ['create-envelope'], response: { b: 2, a: 1 } })
  )
  observe('ackRepeat', () =>
    db.mailEnvelopes.ack({
      actor,
      envelopeIds: ['create-envelope', 'create-envelope'],
      response: { a: 1, b: 2 },
    })
  )
  observe('ackConflict', () =>
    db.mailEnvelopes.ack({ actor, envelopeIds: ['create-envelope'], response: null })
  )
  observe('schemaCreate', () =>
    db.mailEnvelopes.create({
      ...base,
      ingressId: 'schema-ingress',
      envelopeId: 'schema-envelope',
      replySchema: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: { status: { const: 'ok' } },
      },
    })
  )
  observe('schemaPresent', () => db.mailEnvelopes.presentPendingForTarget(target))
  observe('schemaMissing', () => db.mailEnvelopes.ack({ actor, envelopeIds: ['schema-envelope'] }))
  observe('schemaWrong', () =>
    db.mailEnvelopes.ack({
      actor,
      envelopeIds: ['schema-envelope'],
      response: { status: 'bad', extra: 1 },
    })
  )
  observe('batchSchema', () =>
    db.mailEnvelopes.ack({
      actor,
      envelopeIds: ['schema-envelope', 'create-envelope'],
      response: { status: 'ok' },
    })
  )
  observe('schemaAck', () =>
    db.mailEnvelopes.ack({ actor, envelopeIds: ['schema-envelope'], response: { status: 'ok' } })
  )
  observe('emptyAck', () => db.mailEnvelopes.ack({ actor, envelopeIds: [] }))
  observe('unknownAck', () => db.mailEnvelopes.ack({ actor, envelopeIds: ['missing'] }))
  observe('invalidSchemaBeforeReceipt', () =>
    db.mailEnvelopes.create({ ...base, replySchema: { $ref: 'https://example.invalid/no' } })
  )
  observe('emptyIngress', () => db.mailEnvelopes.create({ ...base, ingressId: ' ' }))
  observe('emptyTarget', () => db.mailEnvelopes.create({ ...base, targetSessionRef: ' ' }))
  observe('emptyBody', () =>
    db.mailEnvelopes.create({ ...base, payload: { kind: 'request', body: ' ' } })
  )
  console.log(
    JSON.stringify({
      results: result,
      envelopes: db.sqlite.query('SELECT * FROM hrcmail_envelopes ORDER BY envelope_seq').all(),
      receipts: db.sqlite.query('SELECT * FROM hrcmail_ingress_receipts ORDER BY ingress_id').all(),
    })
  )
} finally {
  db.close()
}
