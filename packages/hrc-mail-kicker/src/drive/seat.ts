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
  | { state: 'idle'; runtimeId: string; steerCapable: boolean }
  | { state: 'turn-active'; runtimeId: string; turnId: string; steerCapable: boolean }
  | { state: 'turn-observed'; runtimeId: string; turnId: string }
  | { state: 'starting' | 'stopping' | 'terminal'; runtimeId: string }

export function seatCanDispatch(seat: ObservedBrokerSeat): boolean {
  return seat.state === 'idle' || seat.state === 'absent'
}

/** Does the broker in front of this runtime advertise the `steer` admission class? */
export async function runtimeAdvertisesSteer(
  server: MailKickerContext,
  runtimeId: string
): Promise<boolean> {
  return (await server.port.seat(runtimeId)).admissionClasses?.includes('steer') ?? false
}

export async function observeBrokerSeat(
  server: MailKickerContext,
  session: HrcSessionRecord
): Promise<ObservedBrokerSeat> {
  const runtime = (await server.port.runtimesByHostSession(session.hostSessionId))
    .filter(
      (candidate) =>
        candidate.generation === session.generation &&
        candidate.controllerKind === 'harness-broker' &&
        candidate.activeInvocationId !== undefined &&
        !isRuntimeUnavailableStatus(candidate.status)
    )
    .at(-1)
  if (runtime === undefined) return { state: 'absent' }
  const probe = await server.port.seat(runtime.runtimeId)
  if (probe.probe === null) return { state: 'unavailable', runtimeId: runtime.runtimeId }
  const seat = probe.probe.seat
  return seat.state === 'turn-active'
    ? {
        state: 'turn-active',
        runtimeId: runtime.runtimeId,
        turnId: String(seat.turnId),
        steerCapable: await runtimeAdvertisesSteer(server, runtime.runtimeId),
      }
    : seat.state === 'turn-observed'
      ? {
          state: 'turn-observed',
          runtimeId: runtime.runtimeId,
          turnId: String(seat.turnId),
        }
      : seat.state === 'idle'
        ? {
            state: 'idle',
            runtimeId: runtime.runtimeId,
            steerCapable: await runtimeAdvertisesSteer(server, runtime.runtimeId),
          }
        : { state: seat.state, runtimeId: runtime.runtimeId }
}
