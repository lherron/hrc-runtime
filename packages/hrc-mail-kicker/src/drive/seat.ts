/**
 * The seat's own observed turn state, and what its driver will accept.
 *
 * Read from the BROKER, never from an HRC run row. Human-typed pane turns mint
 * no HRC run (the failed first cut of T-07890) while the broker observes both
 * those turns and HRC-driven ones, so the seat probe is the one busy/idle
 * authority — and D2 turns on exactly that distinction, because the whole point
 * of steering is to reach a reader who is mid-turn however that turn began.
 *
 * `steerCapable` comes from the FROZEN broker hello capability projection on the
 * active invocation, not from published driver code: a headless runtime owns a
 * long-lived broker process that survives HRC restarts, so an installed upgrade
 * does not change what the broker in front of this seat can actually do.
 */
import type { HrcSessionRecord } from 'hrc-core'

import type { MailKickerContext } from '../context.js'
import { isRuntimeUnavailableStatus } from '../internal.js'

export type ObservedBrokerSeat =
  | { state: 'absent' }
  | { state: 'unavailable'; runtimeId: string }
  | { state: 'idle'; runtimeId: string }
  | { state: 'turn-active'; runtimeId: string; turnId: string; steerCapable: boolean }
  | { state: 'turn-observed'; runtimeId: string; turnId: string }
  | { state: 'starting' | 'stopping' | 'terminal'; runtimeId: string }

export function seatCanDispatch(seat: ObservedBrokerSeat): boolean {
  return seat.state === 'idle' || seat.state === 'absent'
}

/** Does the broker in front of this runtime advertise the `steer` admission class? */
export function runtimeAdvertisesSteer(server: MailKickerContext, runtimeId: string): boolean {
  const runtime = server.db.runtimes.getByRuntimeId(runtimeId) ?? undefined
  if (runtime?.activeInvocationId === undefined) return false
  const invocation = server.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
  const capabilitiesJson = invocation?.capabilitiesJson
  if (capabilitiesJson === undefined) return false
  try {
    const capabilities = JSON.parse(capabilitiesJson) as { admission?: { classes?: unknown } }
    const classes = capabilities.admission?.classes
    return Array.isArray(classes) && classes.includes('steer')
  } catch {
    return false
  }
}

export async function observeBrokerSeat(
  server: MailKickerContext,
  session: HrcSessionRecord
): Promise<ObservedBrokerSeat> {
  const runtime = server.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .filter(
      (candidate) =>
        candidate.generation === session.generation &&
        candidate.controllerKind === 'harness-broker' &&
        candidate.activeInvocationId !== undefined &&
        !isRuntimeUnavailableStatus(candidate.status)
    )
    .at(-1)
  if (runtime === undefined) return { state: 'absent' }
  const probe = await server.broker.seatProbe(runtime.runtimeId)
  if (!probe.ok) return { state: 'unavailable', runtimeId: runtime.runtimeId }
  const seat = probe.response.seat
  return seat.state === 'turn-active'
    ? {
        state: 'turn-active',
        runtimeId: runtime.runtimeId,
        turnId: String(seat.turnId),
        steerCapable: runtimeAdvertisesSteer(server, runtime.runtimeId),
      }
    : seat.state === 'turn-observed'
      ? {
          state: 'turn-observed',
          runtimeId: runtime.runtimeId,
          turnId: String(seat.turnId),
        }
      : { state: seat.state, runtimeId: runtime.runtimeId }
}
