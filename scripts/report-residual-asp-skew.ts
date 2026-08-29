#!/usr/bin/env bun
/**
 * Residual ASP skew AFTER `just pull-deps`.
 *
 * pull-deps advances bun.lock to the registry's latest published tuple. If the
 * sibling agent-spaces checkout is STILL ahead of that, the gap is unpublished
 * work and no amount of pulling closes it — the fix lives in agent-spaces, so this
 * says so by name rather than reporting a generic staleness the operator cannot act
 * on from here. Never fails: pull-deps is a remediation path, and refusing the
 * remediation is not a gate.
 */
import { resolve } from 'node:path'

import { formatAspSkewDetail, readAspSkew } from './lib/asp-skew'

const skew = await readAspSkew(resolve(import.meta.dir, '..'))
if (skew.status !== 'skew') {
  console.error('[pull-deps] ASP graph in sync: the lock now names the sibling checkout HEAD')
  process.exit(0)
}
console.error(
  `[pull-deps] RESIDUAL SKEW: agent-spaces has not published HEAD — ${skew.ahead.length} commit(s) exist in the agent-spaces checkout that no published tuple contains.`
)
for (const line of formatAspSkewDetail(skew)) console.error(line)
console.error(
  '  This repo cannot close it. Publish from agent-spaces (`just publish-dev`), then re-run `just pull-deps` here.'
)
