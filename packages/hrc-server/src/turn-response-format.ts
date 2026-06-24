import {
  HrcErrorCode,
  type HrcRuntimeSnapshot,
  type HrcTurnResponseFormat,
  HrcUnprocessableEntityError,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type {
  BrokerHelloResponse,
  InvocationCapabilities,
  InvocationResponseFormat,
} from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

export function toBrokerResponseFormat(
  responseFormat: HrcTurnResponseFormat | undefined
): InvocationResponseFormat | undefined {
  return responseFormat?.kind === 'json_schema'
    ? { kind: 'json_schema', schema: responseFormat.schema }
    : undefined
}

export function assertRuntimeSupportsResponseFormat(input: {
  db: HrcDatabase
  runtime: HrcRuntimeSnapshot
  responseFormat: HrcTurnResponseFormat | undefined
  route: string
}): void {
  if (input.responseFormat?.kind !== 'json_schema') {
    return
  }
  const invocationId = input.runtime.activeInvocationId
  const invocation =
    invocationId !== undefined ? input.db.brokerInvocations.getByInvocationId(invocationId) : null
  const actual = parseInvocationCapabilities(invocation?.capabilitiesJson)
  if (supportsJsonSchemaPerTurn(actual)) {
    return
  }

  throw unsupportedResponseFormatError({
    route: input.route,
    responseFormat: input.responseFormat,
    actual,
    runtimeId: input.runtime.runtimeId,
    invocationId,
    controllerKind: input.runtime.controllerKind,
    transport: input.runtime.transport,
  })
}

export function preflightDriverSupportsResponseFormat(input: {
  profile: BrokerExecutionProfile
  hello: BrokerHelloResponse
  responseFormat: HrcTurnResponseFormat | undefined
  route: string
  runtimeId?: string | undefined
}): { ok: true } | { ok: false; detail: Record<string, unknown> } {
  if (input.responseFormat?.kind !== 'json_schema') {
    return { ok: true }
  }
  const driver = input.hello.drivers.find(
    (candidate) => candidate.kind === input.profile.brokerDriver
  )
  const actual = driver?.capabilities?.finalResponse ?? null
  if (
    driver?.capabilities?.finalResponse?.jsonSchema === true &&
    driver.capabilities.finalResponse.perTurn === true
  ) {
    return { ok: true }
  }

  return {
    ok: false,
    detail: responseFormatCapabilityDetail({
      route: input.route,
      responseFormat: input.responseFormat,
      actual,
      runtimeId: input.runtimeId,
      brokerDriver: input.profile.brokerDriver,
      driver: driver
        ? {
            kind: driver.kind,
            available: driver.available,
            ...(driver.unavailableReason ? { unavailableReason: driver.unavailableReason } : {}),
          }
        : { kind: input.profile.brokerDriver, missing: true },
    }),
  }
}

export function unsupportedResponseFormatError(input: {
  route: string
  responseFormat: HrcTurnResponseFormat
  actual: InvocationCapabilities | null
  runtimeId?: string | undefined
  invocationId?: string | undefined
  controllerKind?: string | undefined
  transport?: string | undefined
  brokerDriver?: string | undefined
}): HrcUnprocessableEntityError {
  return new HrcUnprocessableEntityError(
    HrcErrorCode.UNSUPPORTED_CAPABILITY,
    'responseFormat json_schema is unsupported for the selected route',
    responseFormatCapabilityDetail(input)
  )
}

function responseFormatCapabilityDetail(input: {
  route: string
  responseFormat: HrcTurnResponseFormat
  actual: InvocationCapabilities['finalResponse'] | InvocationCapabilities | null
  runtimeId?: string | undefined
  invocationId?: string | undefined
  controllerKind?: string | undefined
  transport?: string | undefined
  brokerDriver?: string | undefined
  driver?: Record<string, unknown> | undefined
}): Record<string, unknown> {
  return {
    capability: 'finalResponse.jsonSchema',
    route: input.route,
    responseFormat: { kind: input.responseFormat.kind },
    required: { jsonSchema: true, perTurn: true },
    actual:
      input.actual && 'finalResponse' in input.actual
        ? (input.actual.finalResponse ?? null)
        : input.actual,
    ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
    ...(input.invocationId !== undefined ? { invocationId: input.invocationId } : {}),
    ...(input.controllerKind !== undefined ? { controllerKind: input.controllerKind } : {}),
    ...(input.transport !== undefined ? { transport: input.transport } : {}),
    ...(input.brokerDriver !== undefined ? { brokerDriver: input.brokerDriver } : {}),
    ...(input.driver !== undefined ? { driver: input.driver } : {}),
  }
}

function parseInvocationCapabilities(raw: string | undefined): InvocationCapabilities | null {
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as InvocationCapabilities
  } catch {
    return null
  }
}

function supportsJsonSchemaPerTurn(capabilities: InvocationCapabilities | null): boolean {
  return (
    capabilities?.finalResponse?.jsonSchema === true && capabilities.finalResponse.perTurn === true
  )
}
