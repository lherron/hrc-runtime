import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type MailInspectLedgerRow,
  type WrkqEnvelope,
  buildMailInspection,
  mailInspectEnvelopeIds,
  resolveMailInspectQuery,
} from 'hrc-mail-kicker'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { buildProgram } from '../cli/build-program.js'
import { buildInfoText } from '../cli/help.js'
import { renderMailInspection } from '../mail-inspect.js'

/**
 * `hrc mail inspect` over the T-07963 fixture (T-07964 §6/§7), re-pointed for
 * T-08094.
 *
 * The store is seeded with the EN-03687 shape in its post-drive-attempt form:
 * one LANDED PRESENTATION on a runtime that has gone quiet, no reminder, no
 * failure notice, nothing disposed. That combination must render the `stranded`
 * verdict, because it is the one an operator has to be able to reach without
 * reading five tables.
 */

const SCOPE = 'agent:cody:project:agent-spaces:task:T-07962'
const TARGET = `${SCOPE}/lane:main`
const ENVELOPE = 'EN-03687'
const RUNTIME = 'rt-ab0029c2'
const PRESENTATION = 'present-72fece2f'
const RUN = 'run-72fece2f'
const HOST_SESSION = 'hsid-246e7572'

let tmpDir: string
let db: HrcDatabase

function ledgerRow(state: WrkqEnvelope['state']): Map<string, MailInspectLedgerRow> {
  return new Map<string, MailInspectLedgerRow>([
    [
      ENVELOPE,
      {
        ok: true,
        envelope: {
          uuid: `uuid-${ENVELOPE}`,
          id: ENVELOPE,
          roomUuid: 'room-T-07962',
          roomKey: 'T-07962',
          roomKind: 'task',
          from: { principalRef: 'agent:mable', scopeRef: 'mable@agent-spaces:primary' },
          to: { principalRef: 'agent:cody', scopeRef: 'cody@agent-spaces:T-07962' },
          obligation: 'reply_required',
          delivery: 'queue',
          body: 'Implement T-07962.',
          state,
          terminal: state === 'acked',
          presentedTo: [
            {
              memberRef: 'cody@agent-spaces:T-07962',
              runtimeId: RUNTIME,
              runId: RUN,
              driveAttemptId: PRESENTATION,
              presentedAt: '2026-09-03T22:56:52Z',
            },
          ],
          createdAt: '2026-09-03T22:56:50Z',
          updatedAt: '2026-09-03T22:56:52Z',
        },
      },
    ],
  ])
}

function inspect(rows: Map<string, MailInspectLedgerRow>) {
  const query = resolveMailInspectQuery(ENVELOPE)
  return buildMailInspection(db, query, mailInspectEnvelopeIds(db, query), rows)
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 't07964-cli-'))
  db = openHrcDatabase(join(tmpDir, 'state.sqlite'))
  const now = '2026-09-03T22:56:52Z'
  db.sessions.insert({
    hostSessionId: HOST_SESSION,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME,
    hostSessionId: HOST_SESSION,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    harness: 'codex-app-server',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    createdAt: now,
    updatedAt: now,
  })
  db.runs.insert({
    runId: RUN,
    hostSessionId: HOST_SESSION,
    runtimeId: RUNTIME,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    status: 'failed',
    acceptedAt: now,
    updatedAt: '2026-09-03T23:47:33.266Z',
    errorMessage: 'compiler priming wait aborted',
  })
  db.mailDelivery.recordPresentation({
    envelopeId: ENVELOPE,
    runtimeId: RUNTIME,
    targetSessionRef: TARGET,
    generation: 1,
    presentationId: PRESENTATION,
    inputId: 'sub-72fece2f',
    deliveryOutcome: 'executed',
    landingHrcSeq: 4,
  })
  // This fixture represents a receipt the ledger already accepted, rather
  // than the local-only row left behind by a lost receipt response.
  expect(db.mailDelivery.markReceiptCommitted(ENVELOPE, RUNTIME)).toBe(true)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('hrc mail inspect (T-07964 §6)', () => {
  /** The EN-03687 shape: the runtime that held the obligation is gone. */
  function retireHoldingRuntime(): void {
    db.runtimes.updateStatus(RUNTIME, 'terminated', '2026-09-03T23:47:33.266Z')
  }

  it('renders the stranded verdict for the EN-03687 shape', () => {
    retireHoldingRuntime()
    const view = inspect(ledgerRow('presented')).envelopes[0]
    expect(view?.verdict.code).toBe('stranded')
    expect(view?.verdict.line).toContain('envelope presented, no reminder, no reply')
    expect(view?.presentations[0]?.presentation.presentationId).toBe(PRESENTATION)
    expect(view?.presentations[0]?.presentation.disposition).toBeUndefined()
    expect(view?.intent).toBeUndefined()
    expect(view?.failureNotices).toHaveLength(0)
  })

  it('orders the timeline by instant, not by string, across mixed stamp precision', () => {
    // wrkq stamps to the second and HRC to the millisecond, so the envelope's
    // own creation string-sorts AFTER a landing in the same second: 'Z' > '.'.
    // That put creation below its first presentation in the first cut.
    const landedAt = db.mailDelivery.getPresentation(ENVELOPE, RUNTIME)?.landedAt as string
    expect(landedAt).toContain('.')
    const rows = ledgerRow('presented')
    const row = rows.get(ENVELOPE)
    if (row?.ok !== true) throw new Error('fixture ledger row missing')
    row.envelope.createdAt = `${landedAt.slice(0, 19)}Z`

    const kinds = inspect(rows).envelopes[0]?.timeline.map((event) => event.kind) ?? []
    expect(kinds.indexOf('envelope.created')).toBeLessThan(kinds.indexOf('presentation.landed'))
  })

  it('calls a long-outstanding submission stalled, not awaiting', () => {
    // The T-08094 shape of the T-07971 case: a submission admitted and never
    // landed. `awaiting_landing` here is indistinguishable from health.
    db.mailDelivery.openIntent({
      envelopeId: ENVELOPE,
      targetSessionRef: TARGET,
      door: 'enqueue',
      form: 'full',
      presentationId: 'present-in-flight',
      runtimeId: RUNTIME,
      submittedHrcSeq: 9,
    })
    db.sqlite
      .query('UPDATE hrcmail_delivery_intents SET submitted_at = ? WHERE envelope_id = ?')
      .run(new Date(Date.now() - 6 * 60 * 60_000).toISOString(), ENVELOPE)

    const view = inspect(ledgerRow('presented')).envelopes[0]
    expect(view?.verdict.code).toBe('stalled_delivery')
    expect(view?.verdict.line).toContain('no landing fact')
  })

  it('still calls a fresh submission awaiting_landing', () => {
    db.mailDelivery.openIntent({
      envelopeId: ENVELOPE,
      targetSessionRef: TARGET,
      door: 'steer',
      form: 'full',
      presentationId: 'present-in-flight',
      runtimeId: RUNTIME,
      submittedHrcSeq: 9,
    })
    expect(inspect(ledgerRow('presented')).envelopes[0]?.verdict.code).toBe('awaiting_landing')
  })

  it('never calls a LANDED presentation stalled, however long ago it landed', () => {
    retireHoldingRuntime()
    db.sqlite
      .query('UPDATE hrcmail_presentations SET landed_at = ? WHERE envelope_id = ?')
      .run(new Date(Date.now() - 6 * 60 * 60_000).toISOString(), ENVELOPE)

    expect(inspect(ledgerRow('presented')).envelopes[0]?.verdict.code).toBe('stranded')
  })

  it('yields to the ledger once the obligation is discharged', () => {
    expect(inspect(ledgerRow('acked')).envelopes[0]?.verdict.code).toBe('discharged')
  })

  it('excludes a local-only presentation from reminder authority', () => {
    const localOnlyEnvelope = 'EN-local-only'
    db.mailDelivery.recordPresentation({
      envelopeId: localOnlyEnvelope,
      runtimeId: RUNTIME,
      targetSessionRef: TARGET,
      generation: 1,
      presentationId: 'present-local-only',
      inputId: 'sub-local-only',
      deliveryOutcome: 'executed',
      landingHrcSeq: 5,
    })

    expect(
      db.mailDelivery.getPresentation(localOnlyEnvelope, RUNTIME)?.receiptCommittedAt
    ).toBeUndefined()
    expect(
      db.mailDelivery.armReminder({
        envelopeId: localOnlyEnvelope,
        runtimeId: RUNTIME,
        turnEndedAt: '2026-09-03T23:47:33Z',
        remindAt: '2026-09-03T23:48:33Z',
      })
    ).toBe(false)
  })

  it('reports an armed reminder rather than a strand', () => {
    db.mailDelivery.armReminder({
      envelopeId: ENVELOPE,
      runtimeId: RUNTIME,
      turnEndedAt: '2026-09-03T23:47:33Z',
      remindAt: '2026-09-03T23:48:33Z',
    })
    expect(inspect(ledgerRow('presented')).envelopes[0]?.verdict.code).toBe('reminder_armed')
  })

  it('still answers from HRC rows alone when the ledger cannot be read', () => {
    const rows = new Map<string, MailInspectLedgerRow>([
      [ENVELOPE, { ok: false, error: 'wrkq ledger client is closed' }],
    ])
    const view = inspect(rows).envelopes[0]
    expect(view?.verdict.code).toBe('ledger_unavailable')
    expect(view?.presentations).toHaveLength(1)
    expect(renderMailInspection(inspect(rows))).toContain('ledger   unavailable')
  })

  it('resolves the three target forms by shape alone', () => {
    expect(resolveMailInspectQuery('en-03687')).toEqual({
      kind: 'envelope',
      envelopeId: 'EN-03687',
    })
    expect(resolveMailInspectQuery(RUNTIME)).toEqual({ kind: 'runtime', runtimeId: RUNTIME })
    expect(resolveMailInspectQuery(TARGET)).toEqual({
      kind: 'scope',
      targetSessionRef: TARGET,
    })
    // The handle spelling an agent actually types resolves to the same scope.
    expect(resolveMailInspectQuery('cody@agent-spaces:T-07962')).toEqual({
      kind: 'scope',
      targetSessionRef: TARGET,
    })
    expect(() => resolveMailInspectQuery('not a target')).toThrow(
      'unrecognized mail inspect target'
    )
  })

  it('finds the envelope from the scope and from the runtime that carried it', () => {
    for (const target of [TARGET, RUNTIME]) {
      const query = resolveMailInspectQuery(target)
      expect(mailInspectEnvelopeIds(db, query)).toEqual([ENVELOPE])
    }
  })

  it('renders the verdict as the first line of the human projection', () => {
    retireHoldingRuntime()
    const rendered = renderMailInspection(inspect(ledgerRow('presented')))
    expect(rendered.split('\n')[2]).toContain(`${ENVELOPE}  stranded:`)
  })
})

describe('hrc mail inspect registration (T-07964 §6)', () => {
  it('is a registered command with a --json flag', () => {
    const mail = buildProgram().commands.find((command) => command.name() === 'mail')
    const inspectCommand = mail?.commands.find((command) => command.name() === 'inspect')
    expect(inspectCommand).toBeDefined()
    expect(inspectCommand?.options.some((option) => option.long === '--json')).toBe(true)
  })

  it('appears in both hrc info projections', () => {
    const program = buildProgram()
    expect(buildInfoText(program, undefined, 'agent')).toContain('hrc mail inspect')
    expect(buildInfoText(program, undefined, 'human')).toContain('mail')
  })
})
