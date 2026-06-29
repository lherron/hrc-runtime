/**
 * T-05358 (Defect A) — the dispose RPC must treat an already-closed broker
 * transport as benign, narrowly.
 *
 * The broker socket can close mid-dispose: the durable unix/stdio transport
 * rejects the in-flight RPC with `Broker transport closed`, while a call on an
 * already-closed json-rpc channel rejects with `Broker transport is closed`.
 * Both mean the broker is gone, so disposal is a no-op — swallowing them avoids a
 * spurious `broker_dispose_failed` and narrows the `stopping` window. The guard
 * must stay narrow: ONLY a `BrokerTransportError` whose message is exactly one of
 * the two closed strings; any other transport error must still surface.
 */
import { describe, expect, it } from 'bun:test'

import { isBenignBrokerTransportClosed } from '../broker/controller.js'

function brokerTransportError(message: string): Error {
  const error = new Error(message)
  error.name = 'BrokerTransportError'
  return error
}

describe('T-05358 isBenignBrokerTransportClosed', () => {
  it('swallows the mid-flight unix/stdio close: "Broker transport closed"', () => {
    expect(isBenignBrokerTransportClosed(brokerTransportError('Broker transport closed'))).toBe(true)
  })

  it('swallows the already-closed json-rpc channel: "Broker transport is closed"', () => {
    expect(isBenignBrokerTransportClosed(brokerTransportError('Broker transport is closed'))).toBe(
      true
    )
  })

  it('surfaces a non-closed BrokerTransportError (e.g. timeout)', () => {
    expect(isBenignBrokerTransportClosed(brokerTransportError('Broker transport timeout'))).toBe(
      false
    )
  })

  it('does NOT swallow a closed-message error that is NOT a BrokerTransportError', () => {
    // A generic Error with the same text is not the transport-close signal.
    expect(isBenignBrokerTransportClosed(new Error('Broker transport closed'))).toBe(false)
  })

  it('does NOT swallow a partial/embedded closed message (anchored match only)', () => {
    expect(
      isBenignBrokerTransportClosed(
        brokerTransportError('Broker transport closed unexpectedly during replay')
      )
    ).toBe(false)
  })

  it('returns false for a non-Error value', () => {
    expect(isBenignBrokerTransportClosed('Broker transport closed')).toBe(false)
    expect(isBenignBrokerTransportClosed(undefined)).toBe(false)
  })
})
