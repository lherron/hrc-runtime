const [release, root] = process.argv.slice(2)
if (!root?.startsWith('/tmp/hrcp1-')) throw Error('scratch only')
const { openHrcDatabase } = await import(`${release}/packages/hrc-store-sqlite/src/index.ts`)
const db = openHrcDatabase(`${root}/state.sqlite`, { migrate: false })
const base = {
  idempotencyKey: 'p1-claim',
  requestHash: 'hash',
  baseScope: 'agent:tabularasa:project:hrc-runtime:task:p1-store',
  claimedScope: 'agent:tabularasa:project:hrc-runtime:task:p1-store-suffix',
  successorHostSessionId: 'p1-host',
  createdAt: '2026-10-23T00:00:00.000Z',
}
try {
  db.rosterClaims.insert(base)
  const before = db.rosterClaims.listByBaseScope(base.baseScope)
  let within: unknown
  try {
    db.sqlite
      .transaction(() => {
        db.rosterClaims.insert({
          ...base,
          idempotencyKey: 'p1-rollback',
          claimedScope: `${base.claimedScope}-rollback`,
        })
        within = db.rosterClaims.listByBaseScope(base.baseScope)
        throw Error('fixture roster rollback')
      })
      .immediate()
  } catch (error) {
    if (error.message !== 'fixture roster rollback') throw error
  }
  console.log(
    JSON.stringify({ before, within, after: db.rosterClaims.listByBaseScope(base.baseScope) })
  )
} finally {
  db.close()
}
