import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

const stateRetentionDocUrl = new URL('../../../../docs/state-retention.md', import.meta.url)

test('documents the state retention policy and index adequacy evidence', () => {
  if (!existsSync(stateRetentionDocUrl)) {
    throw new Error(`missing canonical retention doc: ${stateRetentionDocUrl.pathname}`)
  }

  const doc = readFileSync(stateRetentionDocUrl, 'utf8')

  // Non-delta observation events retain indefinitely (Lance ruling 2026-07-28);
  // runtime_buffers is the only observation table that still ages out.
  expect(doc).toMatch(
    /(?=[\s\S]*events)(?=[\s\S]*hrc_events)(?=[\s\S]*broker_invocation_events)(?=[\s\S]*keep-forever)(?=[\s\S]*no TTL)(?=[\s\S]*runtime_buffers)(?=[\s\S]*default 1-day retention)/i
  )
  // The policy must be enforced by the tool's own default, not just the plist.
  expect(doc).toMatch(
    /(?=[\s\S]*--tables)(?=[\s\S]*defaults to\s*`?runtime_buffers)(?=[\s\S]*skipped)/i
  )
  // Fail loudly if the superseded 3-day event window is ever reintroduced.
  expect(doc).not.toMatch(/default 3-day retention/i)
  expect(doc).toMatch(
    /(?=[\s\S]*resume barriers are permanent)(?=[\s\S]*nonterminal runs)(?=[\s\S]*current active run)(?=[\s\S]*imported federation observations)(?=[\s\S]*no archive migration)(?=[\s\S]*auto_vacuum=INCREMENTAL)/i
  )
  // Writer-lock guards: the job shares state.sqlite with the live daemon.
  expect(doc).toMatch(
    /(?=[\s\S]*--deadline-minutes)(?=[\s\S]*--pace-millis)(?=[\s\S]*--max-write-hold-millis)(?=[\s\S]*--max-duty-cycle)(?=[\s\S]*--busy-max-retries)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*full backup)(?=[\s\S]*state\.sqlite)(?=[\s\S]*disk)(?=[\s\S]*defer)(?=[\s\S]*rolling nightly increments)(?=[\s\S]*C-10736)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*sweep)(?=[\s\S]*never deletes)(?=[\s\S]*runtime prune)(?=[\s\S]*default[^\n]*stale)(?=[\s\S]*T-05441)(?=[\s\S]*only stale-row-reaping surface)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*registry-row retention[^\n]*keep forever)(?=[\s\S]*terminated `runtimes` rows[^\n]*keep-forever history)(?=[\s\S]*no TTL)(?=[\s\S]*no pruning)(?=[\s\S]*Lance)(?=[\s\S]*C-10793)(?=[\s\S]*resume-path integrity)(?=[\s\S]*scope_ref)(?=[\s\S]*host_session_id)(?=[\s\S]*harness_session_json)(?=[\s\S]*--resume)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*## Index adequacy)(?=[\s\S]*8571)(?=[\s\S]*terminated[^\n]*7079)(?=[\s\S]*stale[^\n]*1381)(?=[\s\S]*dead[^\n]*72)(?=[\s\S]*ready[^\n]*37)(?=[\s\S]*busy[^\n]*2)(?=[\s\S]*hrc-cli\/src\/cli-runtime\.ts)(?=[\s\S]*idx_runtimes_active_run_id)(?=[\s\S]*hrc-capture-verifier\/src\/sqlite\.ts)(?=[\s\S]*runtime_id[^\n]*PK)(?=[\s\S]*acp-server\/src\/real-launcher\.ts)(?=[\s\S]*idx_runtimes_host_session_id)(?=[\s\S]*SELECT[^\n]*status FROM runtimes)(?=[\s\S]*(?:confirmed|index-covered|disposition))/i
  )
})
