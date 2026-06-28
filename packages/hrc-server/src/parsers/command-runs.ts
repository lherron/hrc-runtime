import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type { LaunchCommandScopedRunBinding, LaunchCommandScopedRunRequest } from 'hrc-core'

import { isRecord, requireTrimmedStringField } from './common.js'

const BINDING_KEYS = [
  'WRKF_TASK_ID',
  'WRKF_ACTION_RUN_ID',
  'WRKF_RUN_ID',
  'WRKF_ACTION',
  'WRKF_ROLE',
  'ASP_PROJECT',
  'HRC_SESSION_REF',
  'HRC_LANE',
] as const satisfies ReadonlyArray<keyof LaunchCommandScopedRunBinding>

const DISALLOWED_COMMAND_MATERIAL = ['command', 'argv', 'cwd', 'env'] as const

export function parseLaunchCommandScopedRunRequest(input: unknown): LaunchCommandScopedRunRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  for (const field of DISALLOWED_COMMAND_MATERIAL) {
    if (input[field] !== undefined) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `${field} is not accepted by command-run launch`,
        { field }
      )
    }
  }

  const bindingInput = input['binding']
  if (!isRecord(bindingInput)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'binding must be an object', {
      field: 'binding',
    })
  }

  const binding = {} as LaunchCommandScopedRunBinding
  for (const key of BINDING_KEYS) {
    binding[key] = requireTrimmedStringField(bindingInput, key)
  }

  return {
    configuredTargetId: requireTrimmedStringField(input, 'configuredTargetId'),
    sessionRef: requireTrimmedStringField(input, 'sessionRef'),
    idempotencyKey: requireTrimmedStringField(input, 'idempotencyKey'),
    binding,
    ...(input['stdinJson'] !== undefined ? { stdinJson: input['stdinJson'] } : {}),
  }
}
