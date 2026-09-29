import type { DispatchTurnResponse } from 'hrc-core'

export type DispatchTurnResponseBase = Omit<
  DispatchTurnResponse,
  'startIdentity' | 'observation' | 'stage' | 'status' | 'outcome' | 'replayed' | 'error'
> & { status: 'started' | 'completed' }

export type JsonRepairRunCorrelation = {
  kind: 'json_repair'
  sourceRunId: string
  failedValidationRunId: string
  repairRunId: string
}
