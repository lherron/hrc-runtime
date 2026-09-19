import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../index.js'
import type { HrcDatabase } from '../index.js'

let tmpDir: string
let db: HrcDatabase

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-submission-admissions-test-'))
  db = openHrcDatabase(join(tmpDir, 'state.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

const ADMISSION = {
  submissionId: 'sub-order-1',
  runId: 'run-order-1',
  runtimeId: 'rt-order-1',
  invocationId: 'inv-order-1',
  door: 'enqueue',
  envelopeId: 'EN-order-1',
  admittedAt: new Date('2026-09-19T00:00:00.000Z').toISOString(),
}

describe('SubmissionAdmissionRepository (T-08611)', () => {
  it('merges the admission edge then the landed edge into one row', async () => {
    db.submissionAdmissions.upsertAdmission(ADMISSION)
    db.submissionAdmissions.recordDisposition({
      submissionId: ADMISSION.submissionId,
      disposition: 'executed',
      disposedAt: new Date('2026-09-19T00:01:00.000Z').toISOString(),
    })
    expect(db.submissionAdmissions.getBySubmissionId(ADMISSION.submissionId)).toMatchObject({
      submissionId: ADMISSION.submissionId,
      runId: ADMISSION.runId,
      runtimeId: ADMISSION.runtimeId,
      invocationId: ADMISSION.invocationId,
      door: 'enqueue',
      envelopeId: 'EN-order-1',
      admittedAt: ADMISSION.admittedAt,
      disposition: 'executed',
    })
  })

  it('merges the landed edge then the admission edge without losing the disposition', async () => {
    db.submissionAdmissions.recordDisposition({
      submissionId: 'sub-raced-1',
      disposition: 'absorbed',
      disposedAt: new Date('2026-09-19T00:01:00.000Z').toISOString(),
    })
    expect(db.submissionAdmissions.getBySubmissionId('sub-raced-1')).toMatchObject({
      disposition: 'absorbed',
    })
    db.submissionAdmissions.upsertAdmission({ ...ADMISSION, submissionId: 'sub-raced-1' })
    expect(db.submissionAdmissions.getBySubmissionId('sub-raced-1')).toMatchObject({
      runId: ADMISSION.runId,
      door: 'enqueue',
      envelopeId: 'EN-order-1',
      disposition: 'absorbed',
    })
  })

  it('keeps dispatch-recorded door/envelope when the mapper attach carries none', async () => {
    db.submissionAdmissions.upsertAdmission(ADMISSION)
    // The event-mapper site never sees the HRC request: no door, no envelope.
    db.submissionAdmissions.upsertAdmission({
      submissionId: ADMISSION.submissionId,
      runId: 'run-mapper-1',
      runtimeId: 'rt-order-1',
      invocationId: 'inv-order-1',
      admittedAt: new Date('2026-09-19T00:02:00.000Z').toISOString(),
    })
    expect(db.submissionAdmissions.getBySubmissionId(ADMISSION.submissionId)).toMatchObject({
      runId: 'run-mapper-1',
      door: 'enqueue',
      envelopeId: 'EN-order-1',
    })
  })

  it('writes a retained disposition only where none exists', async () => {
    // Retained replay fills an absent disposition.
    db.submissionAdmissions.upsertAdmission({ ...ADMISSION, submissionId: 'sub-retained-1' })
    db.submissionAdmissions.recordDisposition({
      submissionId: 'sub-retained-1',
      disposition: 'executed',
      disposedAt: new Date('2026-09-19T00:01:00.000Z').toISOString(),
      onlyIfAbsent: true,
    })
    expect(db.submissionAdmissions.getBySubmissionId('sub-retained-1')?.disposition).toBe(
      'executed'
    )
    // Retained replay never clobbers a live-committed disposition.
    db.submissionAdmissions.recordDisposition({
      submissionId: 'sub-retained-1',
      disposition: 'absorbed',
      disposedAt: new Date('2026-09-19T00:02:00.000Z').toISOString(),
      onlyIfAbsent: true,
    })
    expect(db.submissionAdmissions.getBySubmissionId('sub-retained-1')).toMatchObject({
      disposition: 'executed',
    })
  })

  it('returns null for an unknown submission', async () => {
    expect(db.submissionAdmissions.getBySubmissionId('sub-missing')).toBeNull()
  })
})
