import {
  type BrokerLifecyclePolicyOverlay,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerHelloResponse,
  BrokerProtocolVersion,
  BrokerTransportKind,
  DriverSummary,
  InvocationCapabilities,
  InvocationLifecycleCapabilities,
} from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile, CapabilityRequirements } from 'spaces-runtime-contracts'

import { BROKER_PROTOCOL_VERSION, BROKER_TRANSPORT } from './constants'
import { preflightLifecyclePolicyCapabilities } from './lifecycle-overlay'

export type CapabilityCheck = {
  ok: boolean
  missing: string[]
  detail: Record<string, unknown>
}

export function preflightBrokerLifecyclePolicy(
  profile: BrokerExecutionProfile,
  lifecyclePolicy: BrokerLifecyclePolicyOverlay | undefined
): void {
  if (!lifecyclePolicy) {
    return
  }
  preflightLifecyclePolicyCapabilities(lifecyclePolicy, routeLifecycleCapabilities(profile))
}

/**
 * The PER-ROUTE transport/protocol the broker.hello is negotiated against
 * (T-01810 / T-01801 Phase 1, contract C-03099). The headless stdio route
 * expects stdio/v1; the durable interactive route expects unix/v2. When omitted
 * the legacy stdio/v1 module consts are used so the headless route is unchanged.
 */
export type ExpectedBrokerNegotiation = {
  protocolVersion: BrokerProtocolVersion
  transport: BrokerTransportKind
}

export function admitBrokerHello(
  profile: BrokerExecutionProfile,
  hello: BrokerHelloResponse,
  expected?: ExpectedBrokerNegotiation
): CapabilityCheck {
  const expectedProtocol = expected?.protocolVersion ?? BROKER_PROTOCOL_VERSION
  const expectedTransport = expected?.transport ?? BROKER_TRANSPORT
  const missing: string[] = []
  const driver = hello.drivers.find((candidate) => candidate.kind === profile.brokerDriver)
  if (hello.protocolVersion !== expectedProtocol) {
    missing.push(`protocolVersion:${expectedProtocol}`)
  }
  if (!hello.capabilities.eventNotifications) {
    missing.push('broker.capabilities.eventNotifications')
  }
  if (!hello.capabilities.transports.includes(expectedTransport)) {
    missing.push(`broker.capabilities.transports.${expectedTransport}`)
  }
  if (
    profile.policy.permissionPolicy.mode === 'ask-client' &&
    !hello.capabilities.brokerToClientRequests
  ) {
    missing.push('broker.capabilities.brokerToClientRequests')
  }
  if (
    profile.expectedCapabilities.control?.attachReplay === 'forbidden' &&
    hello.capabilities.attachReplay === true
  ) {
    missing.push('broker.capabilities.attachReplay.forbidden')
  }

  if (!driver) {
    missing.push(`driver.${profile.brokerDriver}`)
  } else if (!driver.available) {
    missing.push(`driver.${profile.brokerDriver}.available`)
  } else {
    missing.push(...checkPreStartDriverCapabilities(profile.expectedCapabilities, driver))
  }

  return {
    ok: missing.length === 0,
    missing,
    detail: buildAdmissionDetail('pre-start-hello', profile, hello, driver, missing),
  }
}

export function admitStartedInvocation(
  profile: BrokerExecutionProfile,
  hello: BrokerHelloResponse,
  capabilities: InvocationCapabilities
): CapabilityCheck {
  const driver = hello.drivers.find((candidate) => candidate.kind === profile.brokerDriver)
  const missing = checkInvocationCapabilities(profile.expectedCapabilities, capabilities)
  return {
    ok: missing.length === 0,
    missing,
    detail: buildAdmissionDetail(
      'post-start-invocation',
      profile,
      hello,
      driver,
      missing,
      capabilities
    ),
  }
}

function checkPreStartDriverCapabilities(
  requirements: CapabilityRequirements,
  driver: DriverSummary
): string[] {
  const caps = driver.capabilities
  if (!caps) {
    return []
  }
  const missing: string[] = []
  checkNeed(missing, 'input.user', requirements.input?.user, caps.input.user)
  checkNeed(missing, 'input.steer', requirements.input?.steer, caps.input.steer)
  checkNeed(
    missing,
    'input.appendContext',
    requirements.input?.appendContext,
    caps.input.appendContext
  )
  checkNeed(missing, 'input.localImages', requirements.input?.localImages, caps.input.localImages)
  checkNeed(missing, 'input.fileRefs', requirements.input?.fileRefs, caps.input.fileRefs)
  checkNeed(missing, 'input.queue', requiredOnly(requirements.input?.queue), caps.input.queue)
  if (
    requirements.turns?.concurrency === 'multiple' &&
    requirements.turns.concurrency !== caps.turns.concurrency
  ) {
    missing.push(`turns.concurrency.${requirements.turns.concurrency}`)
  }
  checkNeed(
    missing,
    'turns.interrupt',
    requirements.turns?.interrupt,
    caps.turns.interrupt !== 'unsupported'
  )
  checkNeed(missing, 'continuation', requirements.continuation, caps.continuation.supported)
  if (requirements.permissions === 'client-mediated') {
    checkNeed(
      missing,
      'permissions.brokerToClientRequests',
      'required',
      caps.permissions?.brokerToClientRequests ?? false
    )
  }
  checkNeed(
    missing,
    'events.assistantDeltas',
    requirements.events?.assistantDeltas,
    caps.events.assistantDeltas
  )
  checkNeed(missing, 'events.toolCalls', requirements.events?.toolCalls, caps.events.toolCalls)
  checkNeed(missing, 'events.usage', requirements.events?.usage, caps.events.usage)
  checkNeed(
    missing,
    'events.diagnostics',
    requirements.events?.diagnostics,
    caps.events.diagnostics
  )
  checkNeed(missing, 'control.stop', requirements.control?.stop, caps.control.stop)
  checkNeed(missing, 'control.dispose', requirements.control?.dispose, caps.control.dispose)
  checkNeed(
    missing,
    'control.reconcile',
    requirements.control?.reconcile,
    caps.control.status ?? false
  )
  return missing
}

function checkInvocationCapabilities(
  requirements: CapabilityRequirements,
  caps: InvocationCapabilities
): string[] {
  const missing: string[] = []
  checkNeed(missing, 'input.user', requirements.input?.user, caps.input.user)
  checkNeed(missing, 'input.steer', requirements.input?.steer, caps.input.steer)
  checkNeed(
    missing,
    'input.appendContext',
    requirements.input?.appendContext,
    caps.input.appendContext
  )
  checkNeed(missing, 'input.localImages', requirements.input?.localImages, caps.input.localImages)
  checkNeed(missing, 'input.fileRefs', requirements.input?.fileRefs, caps.input.fileRefs)
  checkNeed(missing, 'input.queue', requirements.input?.queue, caps.input.queue)
  if (
    requirements.turns?.concurrency &&
    requirements.turns.concurrency !== 'any' &&
    requirements.turns.concurrency !== caps.turns.concurrency
  ) {
    missing.push(`turns.concurrency.${requirements.turns.concurrency}`)
  }
  checkNeed(
    missing,
    'turns.interrupt',
    requirements.turns?.interrupt,
    caps.turns.interrupt !== 'unsupported'
  )
  checkNeed(missing, 'continuation', requirements.continuation, caps.continuation.supported)
  if (requirements.permissions === 'client-mediated') {
    checkNeed(
      missing,
      'permissions.brokerToClientRequests',
      'required',
      caps.permissions?.brokerToClientRequests ?? false
    )
  }
  checkNeed(
    missing,
    'events.assistantDeltas',
    requirements.events?.assistantDeltas,
    caps.events.assistantDeltas
  )
  checkNeed(missing, 'events.toolCalls', requirements.events?.toolCalls, caps.events.toolCalls)
  checkNeed(missing, 'events.usage', requirements.events?.usage, caps.events.usage)
  checkNeed(
    missing,
    'events.diagnostics',
    requirements.events?.diagnostics,
    caps.events.diagnostics
  )
  checkNeed(missing, 'control.stop', requirements.control?.stop, caps.control.stop)
  checkNeed(missing, 'control.dispose', requirements.control?.dispose, caps.control.dispose)
  checkNeed(
    missing,
    'control.reconcile',
    requirements.control?.reconcile,
    caps.control.status ?? false
  )
  return missing
}

function buildAdmissionDetail(
  phase: 'pre-start-hello' | 'post-start-invocation',
  profile: BrokerExecutionProfile,
  hello: BrokerHelloResponse,
  driver: DriverSummary | undefined,
  missing: string[],
  effectiveCapabilities?: InvocationCapabilities | undefined
): Record<string, unknown> {
  return {
    phase,
    missing,
    protocolVersion: hello.protocolVersion,
    brokerCapabilities: hello.capabilities,
    driver: driver
      ? {
          kind: driver.kind,
          available: driver.available,
          rawCapabilities: driver.capabilities,
          ...(driver.unavailableReason ? { unavailableReason: driver.unavailableReason } : {}),
        }
      : { kind: profile.brokerDriver, available: false, missing: true },
    expectedCapabilities: profile.expectedCapabilities,
    ...(effectiveCapabilities ? { effectiveCapabilities } : {}),
  }
}

function checkNeed(
  missing: string[],
  path: string,
  need: 'required' | 'optional' | 'forbidden' | undefined,
  actual: boolean
): void {
  if (need === 'required' && !actual) {
    missing.push(path)
  }
  if (need === 'forbidden' && actual) {
    missing.push(`${path}.forbidden`)
  }
}

function requiredOnly(
  need: 'required' | 'optional' | 'forbidden' | undefined
): 'required' | 'optional' | undefined {
  return need === 'required' ? 'required' : need === 'optional' ? 'optional' : undefined
}

function routeLifecycleCapabilities(
  profile: BrokerExecutionProfile
): InvocationLifecycleCapabilities {
  const lifecycle = profile.expectedCapabilities.lifecycle
  if (lifecycle && Array.isArray(lifecycle.runtimeRetention)) {
    return {
      runtimeRetention: lifecycle.runtimeRetention,
      harnessRecovery: lifecycle.harnessRecovery,
      turnRetry: lifecycle.turnRetry,
      generationFencing: lifecycle.generationFencing === 'required',
      permissionCancellation: lifecycle.permissionCancellation === 'required',
    }
  }
  return CONSERVATIVE_LIFECYCLE_CAPABILITIES
}
