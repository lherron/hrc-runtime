import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'
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
 * `hrc mail inspect` over the T-07963 fixture (T-07964 §6/§7).
 *
 * The store is seeded with the EN-03687 shape: one drive attempt, one
 * presentation receipt, a run that never dispatched an input, an attempt failed
 * by the stop, and no reminder, no failure notice and no auto-reply intent
 * behind it. That combination must render the `stranded` verdict, because it is
 * the one an operator has to be able to reach without reading five tables.
 */

const SCOPE = 'agent:cody:project:agent-spaces:task:T-07962'
const TARGET = `${SCOPE}/lane:main`
const ENVELOPE = 'EN-03687'
const RUNTIME = 'rt-ab0029c2'
const DRIVE = 'drive-72fece2f'
const RUN = 'run-72fece2f'
const HOST_SESSION = 'hsid-246e7572'

const INTENT: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/cody',
    projectRoot: '/tmp/agent-spaces',
    cwd: '/tmp/agent-spaces',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: { provider: 'openai', id: 'codex-app-server', interactive: false },
  execution: { preferredMode: 'nonInteractive' },
}

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
              driveAttemptId: DRIVE,
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

function inspect(
  rows: Map<string, MailInspectLedgerRow>,
  projectTurnResponse?: (runId: string) => { body: string; truncated: boolean }
) {
  const query = resolveMailInspectQuery(ENVELOPE)
  return buildMailInspection(
    db,
    query,
    mailInspectEnvelopeIds(db, query),
    rows,
    projectTurnResponse
  )
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
  db.mailDrives.claim(
    TARGET,
    'insert',
    { envelopeIds: [ENVELOPE], materializationIntent: INTENT },
    { driveAttemptId: DRIVE, runId: RUN }
  )
  db.mailDrives.recordSession(DRIVE, {
    hostSessionId: HOST_SESSION,
    generation: 1,
    runtimeId: RUNTIME,
  })
  db.mailDrives.presentForAttempt(DRIVE, [ENVELOPE])
  db.mailDrives.failWithoutStart(DRIVE, 'compiler priming wait aborted')
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('hrc mail inspect (T-07964 §6)', () => {
  it('renders the stranded verdict for the EN-03687 shape', () => {
    const view = inspect(ledgerRow('presented')).envelopes[0]
    expect(view?.verdict.code).toBe('stranded')
    expect(view?.verdict.line).toContain('envelope presented, no reminder, no reply')
    expect(view?.attempts[0]?.attempt.driveAttemptId).toBe(DRIVE)
    expect(view?.attempts[0]?.run?.dispatchedInputId).toBeUndefined()
    expect(view?.reminders).toHaveLength(0)
    expect(view?.failureNotices).toHaveLength(0)
  })

  it('orders the timeline by instant, not by string, across mixed stamp precision', () => {
    // wrkq stamps to the second and HRC to the millisecond, so the envelope's
    // own creation string-sorts AFTER a claim in the same second: 'Z' > '.'.
    // That put creation below its first presentation in the first cut.
    const claimedAt = db.mailDrives.getAttempt(DRIVE)!.claimedAt
    expect(claimedAt).toContain('.')
    const rows = ledgerRow('presented')
    const row = rows.get(ENVELOPE)
    if (row?.ok !== true) throw new Error('fixture ledger row missing')
    row.envelope.createdAt = `${claimedAt.slice(0, 19)}Z`

    const kinds = inspect(rows).envelopes[0]?.timeline.map((event) => event.kind) ?? []
    expect(kinds.indexOf('envelope.created')).toBeLessThan(kinds.indexOf('attempt.claimed'))
    expect(kinds.indexOf('attempt.claimed')).toBeLessThan(kinds.indexOf('attempt.failed'))
  })

  it('calls a long-live attempt with no turn.started stalled, not awaiting', () => {
    // Reset the fixture's terminal attempt back to the live, never-started shape
    // and age it past the threshold: this is the T-07971 case mable assigned the
    // interim net, and `awaiting_turn` here is indistinguishable from health.
    db.sqlite
      .query(
        "UPDATE hrcmail_drive_attempts SET state = 'claimed', completed_at = NULL, claimed_at = ? WHERE drive_attempt_id = ?"
      )
      .run(new Date(Date.now() - 6 * 60 * 60_000).toISOString(), DRIVE)

    const view = inspect(ledgerRow('presented')).envelopes[0]
    expect(view?.verdict.code).toBe('stalled_delivery')
    expect(view?.verdict.line).toContain('with no turn.started')
  })

  it('still calls a freshly claimed attempt awaiting_turn', () => {
    db.sqlite
      .query(
        "UPDATE hrcmail_drive_attempts SET state = 'claimed', completed_at = NULL, claimed_at = ? WHERE drive_attempt_id = ?"
      )
      .run(new Date().toISOString(), DRIVE)

    expect(inspect(ledgerRow('presented')).envelopes[0]?.verdict.code).toBe('awaiting_turn')
  })

  it('never calls a started attempt stalled, however long it has run', () => {
    db.sqlite
      .query(
        "UPDATE hrcmail_drive_attempts SET state = 'started', completed_at = NULL, claimed_at = ?, started_at = ?, start_hrc_seq = 1 WHERE drive_attempt_id = ?"
      )
      .run(
        new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
        new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
        DRIVE
      )

    expect(inspect(ledgerRow('presented')).envelopes[0]?.verdict.code).toBe('awaiting_turn')
  })

  it('yields to the ledger once the obligation is discharged', () => {
    expect(inspect(ledgerRow('acked')).envelopes[0]?.verdict.code).toBe('discharged')
  })

  it('reports an armed reminder rather than a strand', () => {
    db.mailDrives.armReminder({
      envelopeId: ENVELOPE,
      runtimeId: RUNTIME,
      targetSessionRef: TARGET,
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
    expect(view?.attempts).toHaveLength(1)
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

describe('T-07969 hrc mail inspect canonical response', () => {
  it('reports the projected response for an attempt that has a run', () => {
    // Criterion 4, out-of-process half: the CLI supplies the ONE server-owned
    // projection the same way it supplies the ledger rows, so inspect never
    // grows a second canonical-response reader.
    const projected: string[] = []
    const inspection = inspect(ledgerRow('presented'), (runId) => {
      projected.push(runId)
      return { body: 'the answer that was never minted', truncated: false }
    })

    const attempt = inspection.envelopes[0]?.attempts[0]
    expect(attempt?.canonicalResponse).toBe('the answer that was never minted')
    expect(projected.length).toBeGreaterThan(0)
  })

  it('omits the field when the projection is empty', () => {
    const inspection = inspect(ledgerRow('presented'), () => ({ body: '', truncated: false }))
    expect(inspection.envelopes[0]?.attempts[0]).not.toHaveProperty('canonicalResponse')
  })

  it('stays usable with no projector supplied', () => {
    // The builder is still callable without one, so a caller that has no server
    // in the process gets an inspection rather than a crash.
    const inspection = inspect(ledgerRow('presented'))
    expect(inspection.envelopes[0]?.attempts[0]).not.toHaveProperty('canonicalResponse')
  })
})
