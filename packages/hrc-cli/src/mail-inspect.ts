/**
 * `hrc mail inspect <EN-xxxxx | scope | runtime>` — read-only (T-07964 §6).
 *
 * The sender's question is always "what happened to my envelope", and until
 * this command existed the answer lived in five tables and a log file. It reads
 * the store directly, exactly as `monitor show` does, and asks wrkq for the one
 * row HRC does not own.
 *
 * A ledger it cannot reach is NOT an error: the HRC half is still the half that
 * explains a stranded obligation, so the command prints it and says the wrkq
 * row is missing rather than refusing to answer at all.
 */
import { CliUsageError } from 'cli-kit'

import { resolveDatabasePath } from 'hrc-core'
import {
  type MailInspectEnvelope,
  type MailInspectLedgerRow,
  type MailInspectQuery,
  type MailInspection,
  buildMailInspection,
  mailInspectEnvelopeIds,
  resolveMailInspectQuery,
} from 'hrc-mail-kicker'
import { WrkqStdioLedgerClient, projectSemanticTurnResponse } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { printJson } from './print.js'

export type MailInspectFlags = {
  json?: boolean | undefined
}

async function readLedgerRows(
  envelopeIds: readonly string[]
): Promise<Map<string, MailInspectLedgerRow>> {
  const rows = new Map<string, MailInspectLedgerRow>()
  if (envelopeIds.length === 0) return rows
  const ledger = new WrkqStdioLedgerClient()
  try {
    for (const envelope of envelopeIds) {
      try {
        rows.set(envelope, { ok: true, envelope: await ledger.envelopeShow({ envelope }) })
      } catch (error) {
        rows.set(envelope, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } finally {
    await ledger.close()
  }
  return rows
}

function renderEnvelope(view: MailInspectEnvelope): string {
  const lines: string[] = []
  const ledger = view.ledger
  lines.push(`${view.envelopeId}  ${view.verdict.line}`)
  if (ledger !== undefined) {
    lines.push(
      `  ledger   state=${ledger.state} obligation=${ledger.obligation} room=${ledger.roomKey}`
    )
    lines.push(
      `           from=${ledger.from.scopeRef ?? ledger.from.principalRef} to=${
        ledger.to?.scopeRef ?? ledger.to?.principalRef ?? '(unaddressed)'
      }`
    )
  } else if (view.ledgerError !== undefined) {
    lines.push(`  ledger   unavailable: ${view.ledgerError}`)
  }
  for (const entry of view.attempts) {
    const run = entry.run
    lines.push(
      `  attempt  ${entry.attempt.driveAttemptId} state=${entry.attempt.state} runtime=${
        entry.attempt.runtimeId ?? '-'
      }${entry.runtimeStatus === undefined ? '' : `(${entry.runtimeStatus})`}`
    )
    lines.push(
      `           run=${entry.attempt.runId} status=${run?.status ?? 'absent'} dispatchedInputId=${
        run?.dispatchedInputId ?? 'null'
      }`
    )
    if (entry.autoReplyIntent !== undefined) {
      lines.push(
        `           autoReply=${entry.autoReplyIntent.state} attempts=${entry.autoReplyIntent.attemptCount}`
      )
    }
  }
  lines.push(
    `  disposal reminders=${view.reminders.length} failureNotices=${view.failureNotices.length}`
  )
  lines.push('  timeline')
  if (view.timeline.length === 0) {
    lines.push('    (no HRC rows)')
  }
  for (const event of view.timeline) {
    lines.push(`    ${event.at}  ${event.kind.padEnd(24)}${event.detail}`)
  }
  return lines.join('\n')
}

/** The terminal projection: one verdict line, then the joined evidence. */
export function renderMailInspection(inspection: MailInspection): string {
  const header =
    inspection.query.kind === 'envelope'
      ? `envelope ${inspection.query.envelopeId}`
      : inspection.query.kind === 'runtime'
        ? `runtime ${inspection.query.runtimeId}`
        : `scope ${inspection.query.targetSessionRef}`
  const body =
    inspection.envelopes.length === 0
      ? '  (no presentation receipts on this node)'
      : inspection.envelopes.map(renderEnvelope).join('\n\n')
  return `hrc mail inspect — ${header}\n\n${body}\n`
}

export async function cmdMailInspect(target: string, flags: MailInspectFlags): Promise<void> {
  let query: MailInspectQuery
  try {
    query = resolveMailInspectQuery(target)
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error))
  }
  const db = openHrcDatabase(resolveDatabasePath())
  try {
    const envelopeIds = mailInspectEnvelopeIds(db, query)
    const ledgerRows = await readLedgerRows(envelopeIds)
    // The one server-owned projection (T-07969 criterion 4): `hrc mail inspect`
    // runs out-of-process, so it supplies the projector the same way it supplies
    // the ledger rows rather than growing a second canonical-response reader.
    const inspection = buildMailInspection(db, query, envelopeIds, ledgerRows, (runId) =>
      projectSemanticTurnResponse(db, runId)
    )
    if (flags.json === true) {
      printJson(inspection)
      return
    }
    process.stdout.write(renderMailInspection(inspection))
  } finally {
    db.close()
  }
}
