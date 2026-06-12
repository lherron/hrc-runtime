import type { Database } from 'bun:sqlite'
import type {
  HrcActiveRunContributionRequest,
  HrcActiveRunContributionResponse,
  HrcLocalBridgeRecord,
  HrcSurfaceBindingRecord,
} from 'hrc-core'
import type {
  ActiveInputDeliveryRow,
  LocalBridgeRow,
  RuntimeBufferRow,
  SurfaceBindingRow,
} from './rows.js'
import {
  ACTIVE_INPUT_DELIVERY_COLUMNS,
  type HrcActiveInputDeliveryRecord,
  type HrcRuntimeBufferRecord,
  LOCAL_BRIDGE_COLUMNS,
  RUNTIME_BUFFER_COLUMNS,
  SURFACE_BINDING_COLUMNS,
  type SurfaceBindingBindInput,
  execute,
  mapActiveInputDeliveryRow,
  mapLocalBridgeRow,
  mapRuntimeBufferRow,
  mapSurfaceBindingRow,
  requireRecord,
} from './shared.js'

export class LocalBridgeRepository {
  constructor(private readonly db: Database) {}

  create(record: HrcLocalBridgeRecord): HrcLocalBridgeRecord {
    execute(
      this.db,
      `
        INSERT INTO local_bridges (
          bridge_id,
          host_session_id,
          runtime_id,
          transport,
          target,
          expected_host_session_id,
          expected_generation,
          status,
          created_at,
          closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.bridgeId,
      record.hostSessionId,
      record.runtimeId ?? null,
      record.transport,
      record.target,
      record.expectedHostSessionId ?? null,
      record.expectedGeneration ?? null,
      record.status ?? 'active',
      record.createdAt,
      record.closedAt ?? null
    )

    return requireRecord(
      this.findById(record.bridgeId),
      `failed to reload local bridge ${record.bridgeId}`
    )
  }

  findByTarget(transport: string, target: string): HrcLocalBridgeRecord | null {
    const row = this.db
      .query<LocalBridgeRow, [string, string]>(
        `SELECT ${LOCAL_BRIDGE_COLUMNS} FROM local_bridges
          WHERE transport = ? AND target = ?
          ORDER BY created_at ASC
          LIMIT 1`
      )
      .get(transport, target)

    return row ? mapLocalBridgeRow(row) : null
  }

  findById(bridgeId: string): HrcLocalBridgeRecord | null {
    const row = this.db
      .query<LocalBridgeRow, [string]>(
        `SELECT ${LOCAL_BRIDGE_COLUMNS} FROM local_bridges WHERE bridge_id = ?`
      )
      .get(bridgeId)

    return row ? mapLocalBridgeRow(row) : null
  }

  listActive(): HrcLocalBridgeRecord[] {
    const rows = this.db
      .query<LocalBridgeRow, []>(
        `SELECT ${LOCAL_BRIDGE_COLUMNS} FROM local_bridges
          WHERE closed_at IS NULL
          ORDER BY created_at ASC, bridge_id ASC`
      )
      .all()

    return rows.map(mapLocalBridgeRow)
  }

  close(bridgeId: string, closedAt: string): HrcLocalBridgeRecord | null {
    execute(
      this.db,
      `
        UPDATE local_bridges
        SET status = 'closed', closed_at = ?
        WHERE bridge_id = ?
      `,
      closedAt,
      bridgeId
    )

    return this.findById(bridgeId)
  }
}

export class SurfaceBindingRepository {
  constructor(private readonly db: Database) {}

  bind(record: SurfaceBindingBindInput): HrcSurfaceBindingRecord {
    execute(
      this.db,
      `
        INSERT INTO surface_bindings (
          surface_kind,
          surface_id,
          host_session_id,
          runtime_id,
          generation,
          window_id,
          tab_id,
          pane_id,
          bound_at,
          unbound_at,
          reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(surface_kind, surface_id) DO UPDATE SET
          host_session_id = excluded.host_session_id,
          runtime_id = excluded.runtime_id,
          generation = excluded.generation,
          window_id = excluded.window_id,
          tab_id = excluded.tab_id,
          pane_id = excluded.pane_id,
          bound_at = excluded.bound_at,
          unbound_at = NULL,
          reason = NULL
      `,
      record.surfaceKind,
      record.surfaceId,
      record.hostSessionId,
      record.runtimeId,
      record.generation,
      record.windowId ?? null,
      record.tabId ?? null,
      record.paneId ?? null,
      record.boundAt
    )

    return requireRecord(
      this.findBySurface(record.surfaceKind, record.surfaceId),
      `failed to reload surface binding ${record.surfaceKind}:${record.surfaceId}`
    )
  }

  unbind(
    surfaceKind: string,
    surfaceId: string,
    unboundAt: string,
    reason?: string | undefined
  ): HrcSurfaceBindingRecord | null {
    execute(
      this.db,
      `
        UPDATE surface_bindings
        SET unbound_at = ?, reason = ?
        WHERE surface_kind = ? AND surface_id = ?
      `,
      unboundAt,
      reason ?? null,
      surfaceKind,
      surfaceId
    )

    return this.findBySurface(surfaceKind, surfaceId)
  }

  findBySurface(surfaceKind: string, surfaceId: string): HrcSurfaceBindingRecord | null {
    const row = this.db
      .query<SurfaceBindingRow, [string, string]>(
        `SELECT ${SURFACE_BINDING_COLUMNS} FROM surface_bindings
          WHERE surface_kind = ? AND surface_id = ?`
      )
      .get(surfaceKind, surfaceId)

    return row ? mapSurfaceBindingRow(row) : null
  }

  findByRuntime(runtimeId: string): HrcSurfaceBindingRecord[] {
    const rows = this.db
      .query<SurfaceBindingRow, [string]>(
        `SELECT ${SURFACE_BINDING_COLUMNS} FROM surface_bindings
          WHERE runtime_id = ? AND unbound_at IS NULL
          ORDER BY bound_at ASC, surface_kind ASC, surface_id ASC`
      )
      .all(runtimeId)

    return rows.map(mapSurfaceBindingRow)
  }

  listActive(): HrcSurfaceBindingRecord[] {
    const rows = this.db
      .query<SurfaceBindingRow, []>(
        `SELECT ${SURFACE_BINDING_COLUMNS} FROM surface_bindings
          WHERE unbound_at IS NULL
          ORDER BY bound_at ASC, surface_kind ASC, surface_id ASC`
      )
      .all()

    return rows.map(mapSurfaceBindingRow)
  }
}

export class ActiveInputDeliveryRepository {
  constructor(private readonly db: Database) {}

  createPending(input: {
    request: HrcActiveRunContributionRequest
    now: string
    hostSessionId?: string | undefined
    generation?: number | undefined
    runtimeId?: string | undefined
    runId?: string | undefined
  }): HrcActiveInputDeliveryRecord {
    execute(
      this.db,
      `
        INSERT INTO active_input_deliveries (
          input_application_id,
          input_attempt_id,
          idempotency_key,
          host_session_id,
          generation,
          runtime_id,
          run_id,
          status,
          request_json,
          response_json,
          error_code,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?, ?)
      `,
      input.request.inputApplicationId,
      input.request.inputAttemptId,
      input.request.idempotencyKey ?? null,
      input.hostSessionId ?? null,
      input.generation ?? null,
      input.runtimeId ?? null,
      input.runId ?? null,
      JSON.stringify(input.request),
      input.now,
      input.now
    )

    return requireRecord(
      this.getByInputApplicationId(input.request.inputApplicationId),
      `failed to reload active input delivery ${input.request.inputApplicationId}`
    )
  }

  getByInputApplicationId(inputApplicationId: string): HrcActiveInputDeliveryRecord | null {
    const row = this.db
      .query<ActiveInputDeliveryRow, [string]>(
        `SELECT ${ACTIVE_INPUT_DELIVERY_COLUMNS}
           FROM active_input_deliveries
          WHERE input_application_id = ?`
      )
      .get(inputApplicationId)

    return row ? mapActiveInputDeliveryRow(row) : null
  }

  markAccepted(
    inputApplicationId: string,
    response: HrcActiveRunContributionResponse,
    now: string
  ): HrcActiveInputDeliveryRecord {
    return this.markResponse(inputApplicationId, response, now)
  }

  markRejected(
    inputApplicationId: string,
    response: HrcActiveRunContributionResponse,
    now: string
  ): HrcActiveInputDeliveryRecord {
    return this.markResponse(inputApplicationId, response, now)
  }

  markAmbiguous(
    inputApplicationId: string,
    errorCode: string,
    errorMessage: string,
    now: string
  ): HrcActiveInputDeliveryRecord {
    execute(
      this.db,
      `
        UPDATE active_input_deliveries
           SET status = 'ambiguous',
               error_code = ?,
               error_message = ?,
               updated_at = ?
         WHERE input_application_id = ?
      `,
      errorCode,
      errorMessage,
      now,
      inputApplicationId
    )

    return requireRecord(
      this.getByInputApplicationId(inputApplicationId),
      `active input delivery not found: ${inputApplicationId}`
    )
  }

  markFailed(
    inputApplicationId: string,
    errorCode: string,
    errorMessage: string,
    now: string
  ): HrcActiveInputDeliveryRecord {
    execute(
      this.db,
      `
        UPDATE active_input_deliveries
           SET status = 'failed',
               error_code = ?,
               error_message = ?,
               updated_at = ?
         WHERE input_application_id = ?
      `,
      errorCode,
      errorMessage,
      now,
      inputApplicationId
    )

    return requireRecord(
      this.getByInputApplicationId(inputApplicationId),
      `active input delivery not found: ${inputApplicationId}`
    )
  }

  private markResponse(
    inputApplicationId: string,
    response: HrcActiveRunContributionResponse,
    now: string
  ): HrcActiveInputDeliveryRecord {
    execute(
      this.db,
      `
        UPDATE active_input_deliveries
           SET host_session_id = ?,
               generation = ?,
               runtime_id = ?,
               run_id = ?,
               status = ?,
               response_json = ?,
               error_code = ?,
               error_message = ?,
               updated_at = ?
         WHERE input_application_id = ?
      `,
      response.hostSessionId ?? null,
      response.generation ?? null,
      response.runtimeId ?? null,
      response.runId ?? null,
      response.status,
      JSON.stringify(response),
      response.errorCode ?? null,
      response.errorMessage ?? null,
      now,
      inputApplicationId
    )

    return requireRecord(
      this.getByInputApplicationId(inputApplicationId),
      `active input delivery not found: ${inputApplicationId}`
    )
  }
}

export class RuntimeBufferRepository {
  constructor(private readonly db: Database) {}

  append(entry: HrcRuntimeBufferRecord): HrcRuntimeBufferRecord {
    execute(
      this.db,
      `
        INSERT INTO runtime_buffers (
          runtime_id,
          run_id,
          chunk_seq,
          text,
          created_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
      entry.runtimeId,
      entry.runId,
      entry.chunkSeq,
      entry.text,
      entry.createdAt
    )

    const row = this.db
      .query<RuntimeBufferRow, [string, string, number]>(
        `SELECT ${RUNTIME_BUFFER_COLUMNS} FROM runtime_buffers
          WHERE runtime_id = ? AND run_id = ? AND chunk_seq = ?`
      )
      .get(entry.runtimeId, entry.runId, entry.chunkSeq)

    if (!row) {
      throw new Error(
        `failed to reload runtime buffer chunk ${entry.chunkSeq} for ${entry.runtimeId}/${entry.runId}`
      )
    }

    return mapRuntimeBufferRow(row)
  }

  listByRuntimeId(runtimeId: string): HrcRuntimeBufferRecord[] {
    const rows = this.db
      .query<RuntimeBufferRow, [string]>(
        `SELECT ${RUNTIME_BUFFER_COLUMNS} FROM runtime_buffers
          WHERE runtime_id = ?
          ORDER BY created_at ASC, chunk_seq ASC`
      )
      .all(runtimeId)

    return rows.map(mapRuntimeBufferRow)
  }

  listByRunId(runId: string): HrcRuntimeBufferRecord[] {
    const rows = this.db
      .query<RuntimeBufferRow, [string]>(
        `SELECT ${RUNTIME_BUFFER_COLUMNS} FROM runtime_buffers
          WHERE run_id = ?
          ORDER BY chunk_seq ASC`
      )
      .all(runId)

    return rows.map(mapRuntimeBufferRow)
  }
}
