import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  openBindingRegistry,
  readPlacementLedgerRows,
  readScopeRetirements,
  rebuildBindingRegistryFromLedgers,
} from '../packages/hrc-store-sqlite/src/index.ts'
import type {
  PlacementLedgerRecord,
  ScopeRetirementRecord,
} from '../packages/hrc-store-sqlite/src/index.ts'

const [rawTarget, ...rawLedgers] = process.argv.slice(2)
if (rawTarget === undefined || rawLedgers.length === 0) {
  console.error(
    'usage: bun scripts/rebuild-binding-registry.ts <new-binding-registry.sqlite> <node-state.sqlite>...'
  )
  process.exit(2)
}

const targetPath = resolve(rawTarget)
if (existsSync(targetPath)) {
  console.error(`refusing to overwrite existing rebuild target: ${targetPath}`)
  process.exit(2)
}

const rows: PlacementLedgerRecord[] = []
const fences: ScopeRetirementRecord[] = []
for (const rawLedger of rawLedgers) {
  const ledgerPath = resolve(rawLedger)
  if (!existsSync(ledgerPath)) {
    console.error(`node ledger does not exist: ${ledgerPath}`)
    process.exit(2)
  }
  const db = new Database(ledgerPath, { readonly: true })
  try {
    rows.push(...readPlacementLedgerRows(db))
    fences.push(...readScopeRetirements(db))
  } finally {
    db.close()
  }
}

const registry = openBindingRegistry(targetPath)
try {
  const result = rebuildBindingRegistryFromLedgers(registry, rows, fences)
  console.log(
    JSON.stringify({
      ok: true,
      targetPath,
      sourceLedgers: rawLedgers.length,
      sourceRows: rows.length,
      sourceRetirementFences: fences.length,
      ...result,
    })
  )
} finally {
  registry.close()
}
