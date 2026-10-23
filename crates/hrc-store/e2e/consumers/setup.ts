/** Canonical Bun initialization/readback only, explicitly separate from native writers. */
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [release, path, mode] = process.argv.slice(2)
const real = realpathSync(path)
if (!real.startsWith('/private/tmp/hrcp1-consumers-') && !real.startsWith('/tmp/hrcp1-consumers-'))
  throw Error('explicit consumer scratch only')
const store = await import(pathToFileURL(`${release}/packages/hrc-store-sqlite/src/index.ts`).href)
if (mode === 'registry-read') {
  const registry = store.openBindingRegistry(real)
  try {
    console.log(JSON.stringify(registry.list()))
  } finally {
    registry.close()
  }
} else {
  const db = store.openHrcDatabase(real, { migrate: false })
  try {
    if (mode === 'placement') {
      store.createPlacementLedgerRepository(db.sqlite)
      console.log(JSON.stringify({ initialized: true, producer: 'canonical Bun lazy constructor' }))
    } else throw Error('unknown fixed setup mode')
  } finally {
    db.close()
  }
}
