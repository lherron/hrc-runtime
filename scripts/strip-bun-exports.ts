// WHY: Cross-repo consumers (HRC/ACP repos importing published ASP packages)
// would otherwise resolve the `bun` export condition to ./src/*.ts, which is
// not shipped (only `dist` is in `files`). This helper rewrites a package's
// package.json to drop the `bun` key from every `exports` entry that is a
// conditional-export object. Idempotent. Postpack restores the manifest from
// git so the committed file keeps `bun` for the in-monorepo dev experience.
//
// Mirrors packages/cli/scripts/prepack.ts:stripBunExportCondition.

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

async function main() {
  const target = resolve(process.argv[2] ?? process.cwd())
  const pkgPath = resolve(target, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  if (pkg.exports && typeof pkg.exports === 'object') {
    for (const key of Object.keys(pkg.exports)) {
      const v = pkg.exports[key]
      if (v && typeof v === 'object' && !Array.isArray(v) && 'bun' in v) {
        const { bun: _, ...rest } = v
        pkg.exports[key] = rest
      }
    }
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

await main()
