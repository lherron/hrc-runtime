// Build-time declaration only; native diagnostics never invoke Bun.
import { phase1Migrations } from '../../packages/hrc-store-sqlite/src/migrations.js'

await Bun.write(
  new URL('./migration-order.json', import.meta.url),
  `${JSON.stringify(phase1Migrations.map((migration) => migration.id), null, 2)}\n`
)
