// Bun's actual proxy, with the copied release passed explicitly by the runner.
import { Database } from 'bun:sqlite'
const { instrumentSqliteStatements } = await import(process.argv[2])
const raw = new Database(':memory:')
raw.exec(
  'CREATE TABLE telemetry_probe(n INTEGER PRIMARY KEY); INSERT INTO telemetry_probe VALUES(1)'
)
const events = []
let throwing = false
const observe = (event) => {
  events.push(event)
  if (throwing) throw new Error('observer failure')
}
const db = instrumentSqliteStatements(raw, {
  slowStatementThresholdMs: 0,
  onSlowStatement: observe,
})
const cases = {}
function exercise(name, fn, expectedError = false) {
  events.length = 0
  let result = false
  let error = false
  try {
    result = fn()
  } catch {
    error = true
  }
  cases[name] = {
    ok: expectedError ? error : !error && result === true,
    error,
    events: [...events],
  }
}
const sql = 'SELECT 1 AS n UNION ALL SELECT 2 AS n'
exercise('query-get', () => db.query('SELECT 1 AS n').get().n === 1)
exercise('prepare-get', () => db.prepare('SELECT 1 AS n').get().n === 1)
exercise('all', () => db.query(sql).all().length === 2)
exercise('values', () => db.query(sql).values().length === 2)
exercise('raw', () => db.query(sql).raw().length === 2)
exercise('bound', () => db.query('SELECT ? AS n').get(7).n === 7)
exercise('as-chain', () => {
  class Row {}
  return db.query('SELECT 1 AS n').as(Row).get() instanceof Row
})
exercise('database-run', () => {
  db.run('INSERT INTO telemetry_probe VALUES (2)')
  return true
})
exercise('database-exec', () => {
  db.exec('INSERT INTO telemetry_probe VALUES (3)')
  return true
})
exercise('batch', () => {
  db.exec('INSERT INTO telemetry_probe VALUES (4); INSERT INTO telemetry_probe VALUES (5)')
  return true
})
exercise(
  'batch-error',
  () => {
    db.exec('INSERT INTO telemetry_probe VALUES (6); INSERT INTO telemetry_probe VALUES (1)')
  },
  true
)
exercise('iterator-drain', () => {
  let n = 0
  for (const row of db.query(sql).iterate()) n += row.n
  return n === 3
})
exercise('iterator-return', () => {
  const i = db.query(sql).iterate()
  i.next()
  i.return()
  i.return()
  return true
})
exercise(
  'iterator-throw',
  () => {
    const i = db.query(sql).iterate()
    i.next()
    i.throw(new Error('user iterator failure'))
  },
  true
)
exercise('symbol-iterator', () => {
  const i = db.query(sql)[Symbol.iterator]()
  i.next()
  i.return()
  return true
})
exercise('execution-error', () => db.query('SELECT abs(-9223372036854775808)').get(), true)
throwing = true
exercise('callback-throws', () => db.query('SELECT 1 AS n').get().n === 1)
throwing = false
const quiet = instrumentSqliteStatements(raw, {
  slowStatementThresholdMs: Number.MAX_VALUE,
  onSlowStatement: observe,
})
exercise('high-threshold', () => quiet.query('SELECT 1 AS n').get().n === 1)
exercise('plain-open', () => raw.query('SELECT 1 AS n').get().n === 1)
console.log(JSON.stringify(cases))
raw.close()
