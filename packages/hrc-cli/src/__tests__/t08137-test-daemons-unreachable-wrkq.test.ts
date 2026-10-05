import { expect, test } from 'bun:test'

/**
 * T-08137 installed smoke found a fixture `server.started` (pid 58318, release
 * null) on the LIVE hrc-runtime timeline, posted during a pre-push run. The
 * tests that spawn a real `hrc server serve` inherit this process's
 * environment, so their production ledger client resolved the operator shell's
 * wrkq. HRC_WRKQ_DB is the daemon's explicit locator and takes precedence over
 * the shell's WRKQ_DB_PATH (wrkqAuthorityEnvironment, pinned by t05562), so
 * every test process must carry an unreachable one for its spawned daemons.
 */
test('a daemon spawned from a test process inherits an unreachable wrkq locator', () => {
  expect(process.env['HRC_WRKQ_DB']).toBe('rpc://127.0.0.1:1')
})

/**
 * T-10244: a `wrkq` CLI child ignores HRC_WRKQ_DB and read the operator's live
 * ledger. WRKQ_DB outranks WRKQ_DB_PATH (a differing WRKQ_DB_PATH is refused,
 * never honoured), so the hermetic locator lives in WRKQ_DB and the path
 * aliases are dropped; a test that wants a fixture ledger names it with
 * WRKQ_DB or --db.
 */
test('a wrkq child spawned from a test process inherits an unreachable wrkq locator', () => {
  expect(process.env['WRKQ_DB']).toBe('rpc://127.0.0.1:1')
  expect(process.env['WRKQ_DB_PATH']).toBeUndefined()
  expect(process.env['WRKQ_DB_PATH_FILE']).toBeUndefined()
})
