const [release, root, fixture, mode = 'exercise'] = process.argv.slice(2)
if (!root?.startsWith('/tmp/hrcp1-')) throw Error('scratch only')
const { openHrcDatabase } = await import(`${release}/packages/hrc-store-sqlite/src/index.ts`)
const db = openHrcDatabase(`${root}/state.sqlite`, { migrate: false })
const target = 'agent:tabularasa:project:hrc-runtime:task:p1-store'
function capture(name, fn) {
  try {
    return { name, value: fn() }
  } catch (e) {
    return { name, error: { name: e.name, code: e.code, message: e.message, detail: e.detail } }
  }
}
try {
  if (mode === 'origin-read') {
    const envelopes = []
    const records = (await Bun.file(fixture).text()).trimEnd().split('\n')
    for (let index = 0; index < records.length; index++)
      envelopes.push(db.mailFederatedOrigins.getByIngressId(`body-ingress-${index}`).envelope)
    console.log(JSON.stringify({ envelopes }))
  } else if (mode === 'read') {
    console.log(
      JSON.stringify({
        envelopes: db.mailEnvelopes.inbox({ kind: 'operator', principal: 'fixture' }, target),
      })
    )
  } else {
    const records = (await Bun.file(fixture).text())
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const results = []
    for (let index = 0; index < records.length; index++) {
      const record = records[index]
      const input = {
        ingressId: `body-ingress-${index}`,
        envelopeId: `body-envelope-${index}`,
        from: { kind: 'operator', principal: 'fixture' },
        targetSessionRef: target,
        payload: {
          kind: 'request',
          body: String.fromCharCode(...record.units),
          metadata: { case: index },
        },
      }
      const write = (value) =>
        mode === 'origin'
          ? db.mailFederatedOrigins.create({
              request: value,
              envelopeId: input.envelopeId,
              requestMessageId: `body-message-${index}`,
            })
          : db.mailEnvelopes.create(value)
      const create = capture('create', () => write(input))
      const retry = capture('retry', () => write(input))
      const reappend = create.value
        ? capture('reappend', () =>
            write({
              ...input,
              payload: { ...input.payload, body: create.value.envelope.payload.body },
            })
          )
        : null
      results.push({ index, name: record.name, units: record.units, create, retry, reappend })
    }
    console.log(JSON.stringify({ results }))
  }
} finally {
  db.close()
}
