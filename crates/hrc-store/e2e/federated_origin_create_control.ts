const [release, root, phase] = process.argv.slice(2)
if (!root?.startsWith('/tmp/hrcp1-')) throw Error('scratch only')
const { openHrcDatabase } = await import(`${release}/packages/hrc-store-sqlite/src/index.ts`)
const db = openHrcDatabase(`${root}/state.sqlite`, { migrate: false })
const base = JSON.parse(
  '{"ingressId":"origin-ingress","from":{"kind":"operator","principal":"fixture"},"targetSessionRef":" target ","payload":{"kind":"request","body":"X\\ud800Y\\udfff","metadata":{"__proto__":{"kept":true},"b":2,"a":1,"\\ud800":"key"}}}'
)
const results = []
function observe(name, fn) {
  try {
    results.push({ name, value: fn() })
  } catch (e) {
    results.push({
      name,
      error: { name: e.name, code: e.code, message: e.message, detail: e.detail },
    })
  }
}
const create = (request, envelopeId = 'origin-envelope', requestMessageId = 'origin-message') =>
  db.mailFederatedOrigins.create({ request, envelopeId, requestMessageId })
try {
  if (phase === 'missing') {
    observe('missingReceipt', () => create(base))
  } else {
    observe('create', () => create(base))
    observe('repeat', () => create(base, 'ignored-envelope', 'ignored-message'))
    observe('conflict', () => create({ ...base, payload: { ...base.payload, body: 'different' } }))
    observe('prototypeOnlyRepeat', () =>
      create(JSON.parse(JSON.stringify(base).replace('"kept":true', '"kept":false')))
    )
    observe('invalidSchemaBeforeReceipt', () =>
      create({ ...base, replySchema: { $ref: 'https://example.invalid/no' } })
    )
    observe('blank', () =>
      create(
        { ...base, ingressId: ' ', targetSessionRef: ' ', payload: { kind: 'request', body: ' ' } },
        'blank-envelope',
        'blank-message'
      )
    )
    observe('local', () =>
      db.mailEnvelopes.create({
        ...base,
        ingressId: 'local-ingress',
        envelopeId: 'local-envelope',
        payload: { kind: 'request', body: 'local' },
      })
    )
    observe('localToOrigin', () =>
      create(
        { ...base, ingressId: 'local-ingress', payload: { kind: 'request', body: 'local' } },
        'other-envelope',
        'other-message'
      )
    )
    observe('originToLocal', () => db.mailEnvelopes.create({ ...base, envelopeId: 'other-local' }))
  }
  console.log(
    JSON.stringify({
      results,
      origins: db.sqlite.query('SELECT * FROM hrcmail_federated_origins ORDER BY ingress_id').all(),
      receipts: db.sqlite.query('SELECT * FROM hrcmail_ingress_receipts ORDER BY ingress_id').all(),
    })
  )
} finally {
  db.close()
}
