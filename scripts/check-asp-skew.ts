#!/usr/bin/env bun
/**
 * Refuse when the suite's ASP graph is not the graph a release ships.
 *
 * This is the ONE place the refusal belongs: release qualification is where a
 * green suite is asserted to mean a shippable release. It is deliberately NOT in
 * `just install`, `just pull-deps` or `_deploy-node` — a consumer lagging its
 * producer is this platform's intended steady state, and refusing there would turn
 * every agent-spaces commit into a fleet-wide install wedge until a separate ASP
 * publish landed. Those surfaces warn instead.
 *
 * Escape hatch: allow-asp-skew=1. `--warn` reports and always exits 0, which is
 * what install and pull-deps use.
 */
import { resolve } from 'node:path'

import { formatAspGraphBanner, formatAspSkewDetail, readAspSkew } from './lib/asp-skew'

const skew = await readAspSkew(resolve(import.meta.dir, '..'))
console.error(formatAspGraphBanner(skew))
for (const line of formatAspSkewDetail(skew)) console.error(line)

const warnOnly = process.argv.includes('--warn')
if (skew.status !== 'skew') process.exit(0)
if (warnOnly) {
  console.error(
    'check-asp-skew: this is a WARNING, not a failure — a consumer lagging its producer is the intended steady state.\n' +
      '  It becomes a failure only in release qualification, where a green suite is claimed to mean a shippable release.'
  )
  process.exit(0)
}
if (process.argv.slice(2).some((arg) => arg === 'allow-asp-skew=1')) {
  console.error('check-asp-skew: skew accepted via allow-asp-skew=1')
  process.exit(0)
}
console.error(
  'check-asp-skew: release qualification refuses a suite whose ASP graph is not the one a release ships.\n' +
    '  Publish agent-spaces and `just pull-deps`, or pass allow-asp-skew=1 to qualify against the lock anyway.'
)
process.exit(1)
