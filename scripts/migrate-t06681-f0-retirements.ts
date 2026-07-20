import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  applyT06681F0RetirementMigration,
  openBindingRegistry,
  readPlacementLedgerRows,
  readScopeRetirements,
} from '../packages/hrc-store-sqlite/src/index.ts'
import type {
  PlacementLedgerRecord,
  ScopeRetirementRecord,
} from '../packages/hrc-store-sqlite/src/index.ts'

const [rawRegistry, ...rawArgs] = process.argv.slice(2)
const dryRun = rawArgs.includes('--dry-run')
const yes = rawArgs.includes('--yes')
const rawStates = rawArgs.filter((argument) => argument !== '--dry-run' && argument !== '--yes')

if (rawRegistry === undefined || rawStates.length === 0 || dryRun === yes) {
  console.error(
    'usage: bun scripts/migrate-t06681-f0-retirements.ts <binding-registry.sqlite> <node-state.sqlite>... (--dry-run | --yes)'
  )
  process.exit(2)
}

const registryPath = resolve(rawRegistry)
if (!existsSync(registryPath)) {
  console.error(`binding registry does not exist: ${registryPath}`)
  process.exit(2)
}

const ledgerRows: PlacementLedgerRecord[] = []
const retirementFences: ScopeRetirementRecord[] = []
for (const rawState of rawStates) {
  const statePath = resolve(rawState)
  if (!existsSync(statePath)) {
    console.error(`node state store does not exist: ${statePath}`)
    process.exit(2)
  }
  const db = new Database(statePath, { readonly: true })
  try {
    ledgerRows.push(...readPlacementLedgerRows(db))
    retirementFences.push(...readScopeRetirements(db))
  } finally {
    db.close()
  }
}

let previewRoot: string | undefined
let effectiveRegistryPath = registryPath
if (dryRun) {
  previewRoot = mkdtempSync(join(tmpdir(), 'hrc-t06681-f0-preview-'))
  effectiveRegistryPath = join(previewRoot, 'binding-registry.sqlite')
  const source = new Database(registryPath, { readonly: true })
  try {
    writeFileSync(effectiveRegistryPath, source.serialize())
  } finally {
    source.close()
  }
}

const registry = openBindingRegistry(effectiveRegistryPath)
try {
  console.log(
    JSON.stringify(
      applyT06681F0RetirementMigration({
        target: registry,
        ledgerRows,
        retirementFences,
        dryRun,
      }),
      null,
      2
    )
  )
} finally {
  registry.close()
  if (previewRoot !== undefined) rmSync(previewRoot, { recursive: true, force: true })
}
