import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { openKickerStateStore } from '../kicker-state-store.js'

let directory = ''
let source: ReturnType<typeof openHrcDatabase>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hrc-kicker-store-'))
  source = openHrcDatabase(join(directory, 'state.sqlite'))
})

afterEach(async () => {
  source.close()
  await rm(directory, { recursive: true, force: true })
})

describe('kicker state store import', () => {
  it('copies and verifies the frozen HRC delivery state once', () => {
    const target = 'agent:cody:project:hrc-runtime:task:T-08615/lane:main'
    source.mailDelivery.openIntent({
      envelopeId: 'EN-08615',
      targetSessionRef: target,
      door: 'enqueue',
      form: 'full',
      presentationId: 'present-08615',
      submittedHrcSeq: 12,
    })
    source.wrkqLedgerCursors.advance(42)

    const path = join(directory, 'runtime', 'hrc-mail-kicker.sqlite')
    const store = openKickerStateStore(path, { source: source.sqlite, sourcePath: 'state.sqlite' })
    expect(store.mailDelivery.getIntent('EN-08615')?.targetSessionRef).toBe(target)
    expect(store.wrkqLedgerCursors.get()).toBe(42)
    store.close?.()

    // The marker makes later opens independent from the frozen HRC copy.
    source.mailDelivery.clearIntent('EN-08615')
    const reopened = openKickerStateStore(path, {
      source: source.sqlite,
      sourcePath: 'state.sqlite',
    })
    expect(reopened.mailDelivery.getIntent('EN-08615')).toBeDefined()
    reopened.close?.()
  })

  it('refuses a source/destination parity mismatch before marking the import complete', () => {
    const destination = openKickerStateStore(join(directory, 'runtime', 'hrc-mail-kicker.sqlite'))
    destination.wrkqLedgerCursors.advance(7)
    destination.close?.()

    expect(() =>
      openKickerStateStore(join(directory, 'runtime', 'hrc-mail-kicker.sqlite'), {
        source: source.sqlite,
        sourcePath: 'state.sqlite',
      })
    ).toThrow('kicker store import mismatch for wrkq_ledger_cursors')
  })
})
