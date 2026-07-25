import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  type HrcTurnAdmissionCloseRequest,
  type HrcTurnAdmissionState,
} from 'hrc-core'

const TURN_ADMISSION_SCHEMA = 'hrc.turn-admission/v1'
const TURN_ADMISSION_FILE = 'turn-admission.json'

type DurableTurnAdmissionRecord = {
  schemaVersion: typeof TURN_ADMISSION_SCHEMA
  state: 'closed'
  operationId: string
  requestedBy: string | null
  requestedRunId: string | null
  reason?: string | undefined
  closedAt: string
}

function markerPath(runtimeRoot: string): string {
  return join(runtimeRoot, TURN_ADMISSION_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseDurableRecord(raw: string): DurableTurnAdmissionRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (
    !isRecord(parsed) ||
    parsed['schemaVersion'] !== TURN_ADMISSION_SCHEMA ||
    parsed['state'] !== 'closed' ||
    typeof parsed['operationId'] !== 'string' ||
    parsed['operationId'].trim().length === 0 ||
    (parsed['requestedBy'] !== null && typeof parsed['requestedBy'] !== 'string') ||
    (parsed['requestedRunId'] !== null && typeof parsed['requestedRunId'] !== 'string') ||
    typeof parsed['closedAt'] !== 'string'
  ) {
    return undefined
  }
  const reason = parsed['reason']
  if (reason !== undefined && typeof reason !== 'string') return undefined
  return {
    schemaVersion: TURN_ADMISSION_SCHEMA,
    state: 'closed',
    operationId: parsed['operationId'],
    requestedBy: parsed['requestedBy'],
    requestedRunId: parsed['requestedRunId'],
    ...(reason === undefined ? {} : { reason }),
    closedAt: parsed['closedAt'],
  }
}

function loadDurableRecord(runtimeRoot: string): DurableTurnAdmissionRecord | undefined {
  const path = markerPath(runtimeRoot)
  if (!existsSync(path)) return undefined
  try {
    return (
      parseDurableRecord(readFileSync(path, 'utf8')) ?? {
        schemaVersion: TURN_ADMISSION_SCHEMA,
        state: 'closed',
        operationId: 'recovered-corrupt-marker',
        requestedBy: null,
        requestedRunId: null,
        reason: 'turn admission marker was malformed; startup must recover closed',
        closedAt: new Date().toISOString(),
      }
    )
  } catch {
    return {
      schemaVersion: TURN_ADMISSION_SCHEMA,
      state: 'closed',
      operationId: 'recovered-unreadable-marker',
      requestedBy: null,
      requestedRunId: null,
      reason: 'turn admission marker was unreadable; startup must recover closed',
      closedAt: new Date().toISOString(),
    }
  }
}

async function persistDurableRecord(
  runtimeRoot: string,
  record: DurableTurnAdmissionRecord
): Promise<void> {
  const path = markerPath(runtimeRoot)
  const temporaryPath = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  await rename(temporaryPath, path)
}

async function removeDurableRecord(runtimeRoot: string): Promise<void> {
  try {
    await unlink(markerPath(runtimeRoot))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Serializes the durable restart fence against the one central authority that
 * can turn a request into an executing agent turn.
 */
export class TurnAdmissionGate {
  private closed: DurableTurnAdmissionRecord | undefined
  private activeAdmissions = 0
  private readonly idleWaiters = new Set<() => void>()

  constructor(private readonly runtimeRoot: string) {
    this.closed = loadDurableRecord(runtimeRoot)
  }

  snapshot(): HrcTurnAdmissionState {
    const closed = this.closed
    if (!closed) {
      return {
        state: 'open',
        activeAdmissions: this.activeAdmissions,
        durable: false,
      }
    }
    return {
      state: 'closed',
      activeAdmissions: this.activeAdmissions,
      operationId: closed.operationId,
      requestedBy: closed.requestedBy,
      requestedRunId: closed.requestedRunId,
      ...(closed.reason === undefined ? {} : { reason: closed.reason }),
      closedAt: closed.closedAt,
      durable: existsSync(markerPath(this.runtimeRoot)),
    }
  }

  /**
   * Enter turn admission synchronously. The returned release is idempotent and
   * must span durable acceptance (or terminal rejection) of this dispatch.
   */
  admit(options?: { existingAcceptedRun?: boolean | undefined }): () => void {
    const closed = this.closed
    if (closed && options?.existingAcceptedRun !== true) {
      throw new HrcDomainError(
        HrcErrorCode.SERVER_DRAINING,
        'server turn admission is closed for a drained restart',
        {
          retryable: true,
          operationId: closed.operationId,
          requestedBy: closed.requestedBy,
          closedAt: closed.closedAt,
        }
      )
    }

    this.activeAdmissions += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeAdmissions -= 1
      if (this.activeAdmissions === 0) {
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
      }
    }
  }

  async close(request: HrcTurnAdmissionCloseRequest): Promise<HrcTurnAdmissionState> {
    const operationId = request.operationId.trim()
    if (operationId.length === 0) {
      throw new HrcDomainError(
        HrcErrorCode.MALFORMED_REQUEST,
        'turn admission operationId must be non-empty'
      )
    }

    if (this.closed) {
      if (this.closed.operationId !== operationId) {
        throw new HrcConflictError(
          HrcErrorCode.STALE_CONTEXT,
          'turn admission is already closed by another operation',
          {
            requestedOperationId: operationId,
            activeOperationId: this.closed.operationId,
          }
        )
      }
      await this.waitUntilIdle()
      return this.snapshot()
    }

    const record: DurableTurnAdmissionRecord = {
      schemaVersion: TURN_ADMISSION_SCHEMA,
      state: 'closed',
      operationId,
      requestedBy: request.requestedBy ?? null,
      requestedRunId: request.requestedRunId ?? null,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      closedAt: new Date().toISOString(),
    }
    // Close memory first. No later admission can cross the durability await.
    this.closed = record
    try {
      await persistDurableRecord(this.runtimeRoot, record)
    } catch (error) {
      this.closed = undefined
      throw error
    }
    await this.waitUntilIdle()
    return this.snapshot()
  }

  async reopen(operationId?: string): Promise<HrcTurnAdmissionState> {
    if (!this.closed) return this.snapshot()
    if (operationId !== undefined && this.closed.operationId !== operationId) {
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        'turn admission reopen does not own the active operation',
        {
          requestedOperationId: operationId,
          activeOperationId: this.closed.operationId,
        }
      )
    }

    // Remove durable closure before making memory open. A crash between the two
    // starts open, which is correct for an explicitly authorized reopen.
    await removeDurableRecord(this.runtimeRoot)
    this.closed = undefined
    return this.snapshot()
  }

  private async waitUntilIdle(): Promise<void> {
    if (this.activeAdmissions === 0) return
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }
}

export function turnAdmissionMarkerPath(runtimeRoot: string): string {
  return markerPath(runtimeRoot)
}
