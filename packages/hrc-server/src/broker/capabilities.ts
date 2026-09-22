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
} from 'spaces-harness-broker-protocol'

import { BROKER_PROTOCOL_VERSION, BROKER_TRANSPORT } from './constants'
import { preflightLifecyclePolicyCapabilities } from './lifecycle-overlay'

export type CapabilityCheck = {
  ok: boolean
  missing: string[]
  detail: Record<string, unknown>
}

export type BrokerAdmissionClass = 'steer' | 'queue' | 'exclusive' | 'preempt'

/**
 * The admission classes this invocation's driver ADVERTISED, or `undefined` when
 * the frozen projection does not say: absent or unparseable capabilities, or a
 * pre-`admission` capability blob (invocations recorded before the `admission`
 * key existed carry no class list at all, and the ledger still holds them).
 *
 * "Did not say" and "said, and this class is not in the list" are different
 * facts, and only the second may be read as a refusal. Keeping them apart is the
 * whole reason this returns a list rather than a boolean.
 */
export function brokerCapabilitiesAdmissionClasses(
  capabilitiesJson: string | undefined
): BrokerAdmissionClass[] | undefined {
  if (!capabilitiesJson) return undefined
  try {
    const capabilities = JSON.parse(capabilitiesJson) as {
      admission?: { classes?: unknown }
    }
    const classes = capabilities.admission?.classes
    return Array.isArray(classes) ? (classes as BrokerAdmissionClass[]) : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads the frozen broker hello capability projection without reaching into a
 * harness or deriving admission support from runtime/run state.
 */
export function brokerCapabilitiesSupportAdmissionClass(
  capabilitiesJson: string | undefined,
  submissionClass: BrokerAdmissionClass
): boolean {
  return brokerCapabilitiesAdmissionClasses(capabilitiesJson)?.includes(submissionClass) === true
}

/**
 * The reason string HRC reports when it refuses a door the driver did not
 * advertise.
 *
 * Deliberately the broker's OWN capability-layer vocabulary
 * (`invocation-manager.checkAdmission` rejects an unadvertised class with
 * `unsupported:<class>` at layer `capability`): HRC refusing ahead of the call
 * reports exactly what the broker would have reported had the call been made,
 * so the two are one greppable fact rather than two dialects of it. It is
 * distinct from `authority-denied`, which is a fact about the caller, not the
 * driver.
 */
export const BROKER_PREEMPT_UNSUPPORTED_REASON = 'unsupported:preempt'

/**
 * True only when the driver POSITIVELY advertised its admission classes and this
 * class is not among them (T-08337) — the one state in which HRC may refuse a
 * door on the driver's own word. An invocation that never declared its classes
 * is NOT a refusal: treating silence as refusal would retroactively close the
 * preempt door on every legacy invocation, which is a behaviour change nobody
 * asked for and which no capability evidence supports.
 */
export function brokerCapabilitiesRefuseAdmissionClass(
  capabilitiesJson: string | undefined,
  submissionClass: BrokerAdmissionClass
): boolean {
  const classes = brokerCapabilitiesAdmissionClasses(capabilitiesJson)
  return classes !== undefined && !classes.includes(submissionClass)
}

export function preflightBrokerLifecyclePolicy(
  _driverKind: string,
  lifecyclePolicy: BrokerLifecyclePolicyOverlay | undefined
): void {
  if (!lifecyclePolicy) {
    return
  }
  preflightLifecyclePolicyCapabilities(lifecyclePolicy, CONSERVATIVE_LIFECYCLE_CAPABILITIES)
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
  /**
   * OPTIONAL per-route broker CONTROL-capabilities overlay (T-01816 / T-01801
   * Phase 7). When the durable-ipc route passes control.attachReplay:'required'
   * the route REQUIRES attach/replay and the overlay WINS over the compiled
   * profile's expectedCapabilities.control.attachReplay (e.g. 'forbidden') — the
   * frozen audit profile is NOT mutated. When omitted, the profile's own
   * control.attachReplay still applies so capability drift outside the durable
   * route is still caught.
   */
  control?: { attachReplay?: 'required' | 'optional' | 'forbidden' }
}

export function admitBrokerHello(
  driverKind: string,
  hello: BrokerHelloResponse,
  expected?: ExpectedBrokerNegotiation
): CapabilityCheck {
  const expectedProtocol = expected?.protocolVersion ?? BROKER_PROTOCOL_VERSION
  const expectedTransport = expected?.transport ?? BROKER_TRANSPORT
  const missing: string[] = []
  const driver = hello.drivers.find((candidate) => candidate.kind === driverKind)
  if (hello.protocolVersion !== expectedProtocol) {
    missing.push(`protocolVersion:${expectedProtocol}`)
  }
  if (!hello.capabilities.eventNotifications) {
    missing.push('broker.capabilities.eventNotifications')
  }
  if (!hello.capabilities.transports.includes(expectedTransport)) {
    missing.push(`broker.capabilities.transports.${expectedTransport}`)
  }
  const routeAttachReplay = expected?.control?.attachReplay
  if (routeAttachReplay === 'required') {
    // Route overlay WINS for the route HRC selected: the durable-ipc route
    // REQUIRES attach/replay, so the profile's 'forbidden' is suppressed and a
    // hello that does NOT advertise attachReplay:true is rejected as missing.
    if (hello.capabilities.attachReplay !== true) {
      missing.push('broker.capabilities.attachReplay')
    }
  }

  if (!driver) {
    missing.push(`driver.${driverKind}`)
  } else if (!driver.available) {
    missing.push(`driver.${driverKind}.available`)
  }

  return {
    ok: missing.length === 0,
    missing,
    detail: buildAdmissionDetail('pre-start-hello', driverKind, hello, driver, missing),
  }
}

export function admitStartedInvocation(
  driverKind: string,
  hello: BrokerHelloResponse,
  capabilities: InvocationCapabilities
): CapabilityCheck {
  const driver = hello.drivers.find((candidate) => candidate.kind === driverKind)
  const missing: string[] = []
  return {
    ok: missing.length === 0,
    missing,
    detail: buildAdmissionDetail(
      'post-start-invocation',
      driverKind,
      hello,
      driver,
      missing,
      capabilities
    ),
  }
}

function buildAdmissionDetail(
  phase: 'pre-start-hello' | 'post-start-invocation',
  driverKind: string,
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
      : { kind: driverKind, available: false, missing: true },
    ...(effectiveCapabilities ? { effectiveCapabilities } : {}),
  }
}
