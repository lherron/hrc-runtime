import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HRC_MAIL_STOP_HARD_CAP, HRC_MAIL_STOP_REFUSAL_CAP, openHrcDatabase } from '../index.js'
import type { HrcDatabase, HrcMailStopEnvelopeSummary } from '../index.js'

/**
 * The stop-hook's refusal ledger after the wrkq re-point (T-07615).
 *
 * The PREDICATE moved: what blocks a turn is `wrkq.envelope.pendingView`'s
 * `blocking` set, passed in here. What stayed is the part that references a
 * run — how many times this turn has been refused, and over which obligation —
 * so the caps still behave exactly as T-06810 ratified them.
 */

const scope = 'agent:cody:project:hrc-runtime:task:T-07615'
const target = `${scope}/lane:main`

let tmpDir: string
let db: HrcDatabase

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-mail-stop-test-'))
  db = openHrcDatabase(join(tmpDir, 'state.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

function blocking(...envelopeIds: string[]): HrcMailStopEnvelopeSummary[] {
  return envelopeIds.map((envelopeId) => ({
    envelopeId,
    from: 'mable@wrkq:primary',
    roomKey: 'T-07615',
    body: `body of ${envelopeId}`,
  }))
}

/** The marker the refusal cycle keys on: the numeric tail of the newest EN id. */
function newest(envelopeIds: string[]): number {
  return envelopeIds.reduce(
    (high, id) => Math.max(high, Number(/^EN-(\d+)$/.exec(id)?.[1] ?? 0)),
    0
  )
}

function evaluate(runtimeId: string, ids: string[]) {
  return db.mailStopRefusals.evaluate(runtimeId, target, blocking(...ids), newest(ids))
}

describe('HrcMailStopRefusalRepository', () => {
  it('blocks on what wrkq reports as blocking, and allows once that set empties', () => {
    expect(evaluate('run-mail-stop-1', ['EN-00001'])).toMatchObject({
      decision: 'block',
      unackedCount: 1,
      refusalCount: 1,
    })
    expect(evaluate('run-mail-stop-1', ['EN-00001'])).toMatchObject({
      decision: 'block',
      unackedCount: 1,
      refusalCount: 2,
    })

    // A reply or a defer removes it from wrkq's blocking set; nothing local
    // needs to know which of the two happened.
    expect(evaluate('run-mail-stop-1', [])).toMatchObject({
      decision: 'allow',
      reason: 'clear',
      unackedCount: 0,
    })
  })

  it('surfaces the blocking envelopes so the refusal can name them', () => {
    const decision = evaluate('run-mail-stop-1', ['EN-00004'])
    expect(decision.envelopes).toEqual([
      {
        envelopeId: 'EN-00004',
        from: 'mable@wrkq:primary',
        roomKey: 'T-07615',
        body: 'body of EN-00004',
      },
    ])
  })

  it('allows the third refusal, resets the cycle only for new mail, and caps at 50', () => {
    expect(evaluate('run-mail-stop-1', ['EN-00001']).decision).toBe('block')
    expect(evaluate('run-mail-stop-1', ['EN-00001']).decision).toBe('block')
    expect(evaluate('run-mail-stop-1', ['EN-00001'])).toMatchObject({
      decision: 'allow',
      reason: 'refusal_cap',
      refusalCount: HRC_MAIL_STOP_REFUSAL_CAP,
      totalRefusalCount: 3,
    })

    // A NEWER envelope resets the cycle: the agent has not yet been refused
    // over this one.
    expect(evaluate('run-mail-stop-1', ['EN-00001', 'EN-00002'])).toMatchObject({
      decision: 'block',
      refusalCount: 1,
      totalRefusalCount: 4,
    })

    db.sqlite
      .query(
        `UPDATE hrcmail_stop_refusals
         SET refusal_count = 0, total_refusal_count = ?
         WHERE runtime_id = ?`
      )
      .run(HRC_MAIL_STOP_HARD_CAP - 1, 'run-mail-stop-1')
    expect(evaluate('run-mail-stop-1', ['EN-00001', 'EN-00002', 'EN-00003'])).toMatchObject({
      decision: 'allow',
      reason: 'hard_cap',
      totalRefusalCount: HRC_MAIL_STOP_HARD_CAP,
    })
  })

  it('does not reset the cycle when the same obligation is merely re-reported', () => {
    evaluate('run-mail-stop-1', ['EN-00010'])
    // A sweep re-pend, a reordered page: same newest id, so the count advances.
    expect(evaluate('run-mail-stop-1', ['EN-00010'])).toMatchObject({ refusalCount: 2 })
  })

  it('starts fresh counters for a new stable run id', () => {
    evaluate('run-mail-stop-1', ['EN-00001'])
    evaluate('run-mail-stop-1', ['EN-00001'])

    expect(evaluate('run-mail-stop-2', ['EN-00001'])).toMatchObject({
      decision: 'block',
      refusalCount: 1,
      totalRefusalCount: 1,
    })
  })
})
