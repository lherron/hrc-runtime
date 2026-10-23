/** Bounded characterization of unchanged Bun's public prune return values. */
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [release, root, configFile] = process.argv.slice(2)
if (!release || !root?.startsWith('/tmp/hrcp1-') || !configFile)
  throw new Error('explicit scratch required')
const actual = realpathSync(root)
if (!actual.startsWith('/private/tmp/hrcp1-') && !actual.startsWith('/tmp/hrcp1-'))
  throw new Error('scratch escape')
const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
  runs: number[]
  singular: boolean
  includeLedgers: boolean
  setupOnly?: boolean
  direct?: 'cte' | 'plain' | 'simple'
  removeProjection?: boolean
}
const module = await import(
  pathToFileURL(join(release, 'packages/hrc-store-sqlite/src/index.ts')).href
)
const db = module.openHrcDatabase(join(root, 'state.sqlite'), { migrate: false })
try {
  const prototype = db.runtimes.getByRuntimeId('p1-runtime')!
  const original = db.runs.getByRunId('p1-run')!
  db.sqlite.query('DELETE FROM runs').run()
  const ids = config.runs.map((count, index) => {
    const runtimeId = index === 0 ? 'p1-runtime' : `p1-runtime-${index}`
    if (index > 0) db.runtimes.insert({ ...prototype, runtimeId })
    for (let n = 0; n < count; n++)
      db.runs.insert({ ...original, runId: `p1-run-${index}-${n}`, runtimeId })
    return runtimeId
  })
  if (config.removeProjection) db.sqlite.query('DELETE FROM session_index').run()
  const beforeCounts = db.runtimes.countPruneRows(ids, { includeLedgers: config.includeLedgers })
  const beforeSqliteChanges = db.sqlite.query('SELECT changes() AS value').get()
  if (config.setupOnly) {
    console.log(JSON.stringify({ ids, beforeCounts }))
  } else {
    const totalBefore = db.sqlite.query('SELECT total_changes() AS value').get() as {
      value: number
    }
    const result =
      config.direct === 'simple'
        ? db.sqlite.query('DELETE FROM runtimes WHERE runtime_id = ?').run(ids[0]!)
        : config.direct
          ? db.sqlite
              .query(
                config.direct === 'cte'
                  ? 'WITH selected AS MATERIALIZED (SELECT CAST(value AS TEXT) AS runtime_id FROM json_each(?)) DELETE FROM runtimes WHERE runtime_id IN (SELECT runtime_id FROM selected)'
                  : 'DELETE FROM runtimes WHERE runtime_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))'
              )
              .run(JSON.stringify(ids))
          : config.singular
            ? db.runtimes.pruneRuntime(ids[0]!, { includeLedgers: config.includeLedgers })
            : db.runtimes.pruneRuntimes(ids, { includeLedgers: config.includeLedgers })
    const totalAfter = db.sqlite.query('SELECT total_changes() AS value').get() as { value: number }
    const sqliteChanges = db.sqlite.query('SELECT changes() AS value').get()
    const afterCount = db.runtimes.count()
    console.log(
      JSON.stringify({
        config,
        ids,
        beforeCounts,
        beforeSqliteChanges,
        result,
        sqliteChanges,
        totalDelta: totalAfter.value - totalBefore.value,
        afterCount,
      })
    )
  }
} finally {
  db.close()
}
