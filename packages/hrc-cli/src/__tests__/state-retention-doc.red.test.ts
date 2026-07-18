import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

const stateRetentionDocUrl = new URL('../../../../docs/state-retention.md', import.meta.url)

test('documents the state retention policy and index adequacy evidence', () => {
  if (!existsSync(stateRetentionDocUrl)) {
    throw new Error(`missing canonical retention doc: ${stateRetentionDocUrl.pathname}`)
  }

  const doc = readFileSync(stateRetentionDocUrl, 'utf8')

  expect(doc).toMatch(
    /(?=[\s\S]*delta events?)(?=[\s\S]*7[- ]day)(?=[\s\S]*T-06453)(?=[\s\S]*b1cbccc)(?=[\s\S]*T-06554)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*all other history)(?=[\s\S]*keep forever)(?=[\s\S]*non-delta)(?=[\s\S]*no archive migration)(?=[\s\S]*live state db)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*full backup)(?=[\s\S]*state\.sqlite)(?=[\s\S]*disk)(?=[\s\S]*defer)(?=[\s\S]*rolling nightly increments)(?=[\s\S]*C-10736)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*sweep)(?=[\s\S]*never deletes)(?=[\s\S]*runtime prune)(?=[\s\S]*default[^\n]*stale)(?=[\s\S]*T-05441)(?=[\s\S]*only stale-row-reaping surface)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*Lance)(?=[\s\S]*(?:NOT ruled|provisionally deferred))(?=[\s\S]*C-10744)(?=[\s\S]*resume-orphan)(?=[\s\S]*scope_ref)(?=[\s\S]*host_session_id)(?=[\s\S]*harness_session_json)(?=[\s\S]*--resume)(?=[\s\S]*created_at)(?=[\s\S]*NOT last_activity_at)(?=[\s\S]*T-06526)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*## Index adequacy)(?=[\s\S]*8571)(?=[\s\S]*terminated[^\n]*7079)(?=[\s\S]*stale[^\n]*1381)(?=[\s\S]*dead[^\n]*72)(?=[\s\S]*ready[^\n]*37)(?=[\s\S]*busy[^\n]*2)(?=[\s\S]*hrc-cli\/src\/cli-runtime\.ts)(?=[\s\S]*idx_runtimes_active_run_id)(?=[\s\S]*hrc-capture-verifier\/src\/sqlite\.ts)(?=[\s\S]*runtime_id[^\n]*PK)(?=[\s\S]*acp-server\/src\/real-launcher\.ts)(?=[\s\S]*idx_runtimes_host_session_id)(?=[\s\S]*SELECT[^\n]*status FROM runtimes)(?=[\s\S]*(?:confirmed|index-covered|disposition))/i
  )
})
