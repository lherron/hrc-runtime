import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

const stateRetentionDocUrl = new URL('../../../../docs/state-retention.md', import.meta.url)

test('documents the state retention policy and index adequacy evidence', () => {
  if (!existsSync(stateRetentionDocUrl)) {
    throw new Error(`missing canonical retention doc: ${stateRetentionDocUrl.pathname}`)
  }

  const doc = readFileSync(stateRetentionDocUrl, 'utf8')

  // Runtime-owned ledgers follow the verified lake mark; collaboration stays
  // keep-forever, while operational metadata retains its narrower predicates.
  expect(doc).toMatch(
    /(?=[\s\S]*events)(?=[\s\S]*hrc_events)(?=[\s\S]*broker_invocation_events)(?=[\s\S]*keep-forever)(?=[\s\S]*no TTL)(?=[\s\S]*runtime_buffers)(?=[\s\S]*1-day cutoff)(?=[\s\S]*14-day hot window)(?=[\s\S]*verified prune mark)/i
  )
  // Metadata duties remain scheduled even without runtime-prune authority.
  expect(doc).toMatch(
    /(?=[\s\S]*04:25)(?=[\s\S]*retention.report)(?=[\s\S]*no prune window and no mark)/i
  )
  // Fail loudly if the superseded 3-day event window is ever reintroduced.
  expect(doc).not.toMatch(/default 3-day retention/i)
  expect(doc).toMatch(
    /(?=[\s\S]*resume barriers are permanent)(?=[\s\S]*nonterminal runs)(?=[\s\S]*current active run)(?=[\s\S]*imported federation observations)(?=[\s\S]*no archive migration)(?=[\s\S]*auto_vacuum=INCREMENTAL)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*collaboration state[^\n]*keep forever)(?=[\s\S]*`messages`[^\n]*canonical local message)(?=[\s\S]*collective_history_messages)(?=[\s\S]*collective_history_observations)(?=[\s\S]*collective_history_replications)(?=[\s\S]*retained `hrcmail_\*` tables)(?=[\s\S]*no TTL)(?=[\s\S]*replay-fence)/i
  )
  // Writer-lock guards now belong to the owning daemon.
  expect(doc).toMatch(
    /(?=[\s\S]*04:25 deadline)(?=[\s\S]*PACE)(?=[\s\S]*MAX_WRITE_HOLD)(?=[\s\S]*MAX_DUTY_CYCLE)(?=[\s\S]*VACUUM_PAGES)(?=[\s\S]*VACUUM_CHUNK)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*full backup)(?=[\s\S]*state\.sqlite)(?=[\s\S]*disk)(?=[\s\S]*defer)(?=[\s\S]*rolling nightly increments)(?=[\s\S]*C-10736)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*Discovery is a separate read)(?=[\s\S]*adaptive-batch integer key set)(?=[\s\S]*primary\s+key)(?=[\s\S]*full eligibility predicate)(?=[\s\S]*rechecks)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*sweep)(?=[\s\S]*never deletes)(?=[\s\S]*runtime prune)(?=[\s\S]*default[^\n]*stale)(?=[\s\S]*T-05441)(?=[\s\S]*only stale-row-reaping surface)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*## Registry-row retention)(?=[\s\S]*Terminated `runtimes` rows were keep-forever history)(?=[\s\S]*C-10793)(?=[\s\S]*mark-gated prune deletes)(?=[\s\S]*lake holds them)(?=[\s\S]*resume-path integrity)(?=[\s\S]*scope_ref)(?=[\s\S]*host_session_id)(?=[\s\S]*continuation_json)/i
  )
  expect(doc).toMatch(
    /(?=[\s\S]*## Index adequacy)(?=[\s\S]*8571)(?=[\s\S]*terminated[^\n]*7079)(?=[\s\S]*stale[^\n]*1381)(?=[\s\S]*dead[^\n]*72)(?=[\s\S]*ready[^\n]*37)(?=[\s\S]*busy[^\n]*2)(?=[\s\S]*hrc-cli\/src\/cli-runtime\.ts)(?=[\s\S]*idx_runtimes_active_run_id)(?=[\s\S]*hrc-capture-verifier\/src\/sqlite\.ts)(?=[\s\S]*runtime_id[^\n]*PK)(?=[\s\S]*acp-server\/src\/real-launcher\.ts)(?=[\s\S]*idx_runtimes_host_session_id)(?=[\s\S]*SELECT[^\n]*status FROM runtimes)(?=[\s\S]*(?:confirmed|index-covered|disposition))/i
  )
})
