/**
 * RED tests (T-01810 / T-01801 Phase 1) — accept Unix endpoint kinds, per-route
 * broker.hello negotiation, a durable broker-client interface, an HRC durable-IPC
 * feature flag, and a durable-interactive route guard.
 *
 * Governing task: T-01810 (parent T-01801, contract notes C-03078 + C-03099).
 * Phase 1 widens the broker contract so the SAME JSON-RPC/NDJSON broker protocol
 * can ride a Unix-domain socket (transport `unix-jsonrpc-ndjson`, protocol
 * `harness-broker/0.2`) for the durable interactive route, while the headless
 * stdio route stays pinned to `stdio-jsonrpc-ndjson` / `harness-broker/0.1`.
 *
 * These tests pin the Phase-1 CONTRACT and are EXPECTED TO FAIL at HEAD. They go
 * green once the implementation half lands:
 *
 *   #1  PER-ROUTE admitBrokerHello negotiation. Today admitBrokerHello() compares
 *       against the GLOBAL module consts BROKER_PROTOCOL_VERSION ('harness-broker/0.1')
 *       and BROKER_TRANSPORT ('stdio-jsonrpc-ndjson'). The contract is a third
 *       `expected` argument — `{ protocolVersion, transport }` — supplied PER ROUTE.
 *       When omitted the legacy stdio/v1 behaviour is preserved (headless route
 *       unchanged); when present the negotiation uses it. So a unix/v2 hello is
 *       ADMITTED on a route expecting unix/v2 and a stdio/v1 hello is REJECTED on
 *       that route (and vice-versa). NOTE: BROKER_PROTOCOL_VERSION / BROKER_TRANSPORT
 *       must NOT be globally swapped — the stdio headless route keeps working.
 *
 *   #2  Endpoint-kind union round-trip. broker/runtime-state.ts must serialize +
 *       extract a broker endpoint of kind 'unix-jsonrpc-ndjson' (socketPath +
 *       redacted attachTokenRef) ALONGSIDE 'stdio-jsonrpc-ndjson', round-tripping
 *       through runtime_state_json without loss. Contract: exported
 *       `toBrokerEndpointJson()` / `extractBrokerEndpoint()` helpers.
 *
 *   #3  Durable broker-client interface. A durable client exposes attach /
 *       snapshot / eventsSince / ackEvents / permissionRespond OVER AND ABOVE the
 *       existing BrokerClientLike (stdio) shape. Contract: an exported runtime
 *       guard `isDurableBrokerClient()` that accepts a client carrying all five
 *       v2 methods and rejects a stdio-only client.
 *
 *   #4  HRC durable-IPC feature flag. option-resolvers.ts must resolve a durable-IPC
 *       flag from `HRC_BROKER_DURABLE_IPC_ENABLED` — OFF by default (unlike the
 *       default-on broker cutover flags), ON only when the env var is truthy, with
 *       an explicit `options` override winning. Contract: exported
 *       `resolveBrokerDurableIpcEnabled()`.
 *
 *   #5  Durable-interactive route guard. broker-decisions.ts must select the
 *       durable-interactive route ONLY when the durable-IPC flag is on AND the
 *       endpoint kind is unix. Contract: exported
 *       `decideBrokerDurableInteractiveRoute()`.
 *
 * Tests only — no production code is implemented here; they must be RED now.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import type {
  BrokerHelloResponse,
  BrokerProtocolVersion,
  BrokerTransportKind,
} from 'spaces-harness-broker-protocol'

import { admitBrokerHello } from '../broker/capabilities'
// Namespace imports: these modules exist today, but the Phase-1 exports
// referenced below do NOT — so accessing them yields `undefined` (a clean
// per-test assertion failure) rather than a module-load crash.
import * as brokerRuntimeState from '../broker/runtime-state'
import * as brokerController from '../broker/controller'
import * as optionResolvers from '../option-resolvers'
import * as brokerDecisions from '../broker-decisions'

import { makeBrokerProfile, makeIdentity, makeInteractiveTmuxProfile } from './broker-compile-fixtures'

const STDIO: BrokerTransportKind = 'stdio-jsonrpc-ndjson'
const UNIX: BrokerTransportKind = 'unix-jsonrpc-ndjson'
const V1: BrokerProtocolVersion = 'harness-broker/0.1'
const V2: BrokerProtocolVersion = 'harness-broker/0.2'

/**
 * Build a broker hello advertising a given protocol version + transport set and
 * a single AVAILABLE driver matching `driverKind`. The driver carries no
 * `capabilities` (so the deep pre-start capability check short-circuits) — these
 * tests isolate transport/protocol NEGOTIATION, not driver-capability admission.
 */
function makeHello(opts: {
  protocolVersion: BrokerProtocolVersion
  transports: BrokerTransportKind[]
  driverKind: string
}): BrokerHelloResponse {
  return {
    brokerInfo: { name: 'harness-broker', version: '0.0.0-test' },
    protocolVersion: opts.protocolVersion,
    capabilities: {
      multiInvocation: false,
      transports: opts.transports,
      eventNotifications: true,
      brokerToClientRequests: true,
      attachReplay: opts.transports.includes(UNIX),
    },
    drivers: [{ kind: opts.driverKind, version: '1', available: true }],
  }
}

// The PER-ROUTE expectation the Phase-1 admitBrokerHello() must consume as its
// third argument. Encodes "this route expects unix/v2" vs "this route expects
// stdio/v1" instead of reading the global module const.
type ExpectedNegotiation = { protocolVersion: BrokerProtocolVersion; transport: BrokerTransportKind }
const DURABLE_ROUTE: ExpectedNegotiation = { protocolVersion: V2, transport: UNIX }
const STDIO_ROUTE: ExpectedNegotiation = { protocolVersion: V1, transport: STDIO }

// admitBrokerHello takes (profile, hello) today; the third per-route arg is the
// pinned Phase-1 contract. Cast keeps this test compiling before the signature
// widens (bun runs without type-checking; the cast documents intent).
const admit = admitBrokerHello as unknown as (
  profile: Parameters<typeof admitBrokerHello>[0],
  hello: BrokerHelloResponse,
  expected?: ExpectedNegotiation
) => ReturnType<typeof admitBrokerHello>

describe('T-01810 Phase 1 — per-route admitBrokerHello negotiation', () => {
  const { profile: durableProfile } = makeInteractiveTmuxProfile() // brokerDriver: claude-code-tmux
  const { profile: stdioProfile } = makeBrokerProfile(makeIdentity()) // brokerDriver: codex-app-server

  it('ADMITS a unix/v2 hello on a route expecting unix/v2 (RED today)', () => {
    const hello = makeHello({ protocolVersion: V2, transports: [UNIX], driverKind: 'claude-code-tmux' })
    const result = admit(durableProfile, hello, DURABLE_ROUTE)
    // Today admitBrokerHello compares against the GLOBAL stdio/v1 const, so a
    // unix/v2 hello is rejected (protocolVersion + transport "missing"). RED.
    expect(result.missing).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('REJECTS a stdio/v1 hello on a route expecting unix/v2 (RED today)', () => {
    const hello = makeHello({ protocolVersion: V1, transports: [STDIO], driverKind: 'claude-code-tmux' })
    const result = admit(durableProfile, hello, DURABLE_ROUTE)
    // Today the global const IS stdio/v1, so this hello is wrongly ADMITTED. RED.
    expect(result.ok).toBe(false)
  })

  it('ADMITS a stdio/v1 hello on a route expecting stdio/v1 (headless route stays green)', () => {
    const hello = makeHello({ protocolVersion: V1, transports: [STDIO], driverKind: 'codex-app-server' })
    const result = admit(stdioProfile, hello, STDIO_ROUTE)
    expect(result.missing).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('REJECTS a unix/v2 hello on a route expecting stdio/v1 (cross-route)', () => {
    const hello = makeHello({ protocolVersion: V2, transports: [UNIX], driverKind: 'codex-app-server' })
    const result = admit(stdioProfile, hello, STDIO_ROUTE)
    expect(result.ok).toBe(false)
  })

  it('with NO expected arg, preserves legacy stdio/v1 admission (headless unchanged)', () => {
    const hello = makeHello({ protocolVersion: V1, transports: [STDIO], driverKind: 'codex-app-server' })
    const result = admitBrokerHello(stdioProfile, hello)
    expect(result.ok).toBe(true)
  })
})

describe('T-01810 Phase 1 — broker endpoint-kind union round-trip', () => {
  const unixEndpoint = {
    kind: 'unix-jsonrpc-ndjson' as const,
    socketPath: '/tmp/runtime/bipc/abc/b.sock',
    attachTokenRef: { kind: 'file' as const, path: '/tmp/runtime/bipc/abc/token', redacted: true as const },
  }
  const stdioEndpoint = { kind: 'stdio-jsonrpc-ndjson' as const }

  it('round-trips a unix-jsonrpc-ndjson endpoint without loss (RED today)', () => {
    const toJson = (brokerRuntimeState as Record<string, unknown>)['toBrokerEndpointJson'] as
      | ((endpoint: unknown) => Record<string, unknown>)
      | undefined
    const extract = (brokerRuntimeState as Record<string, unknown>)['extractBrokerEndpoint'] as
      | ((json: Record<string, unknown> | undefined) => unknown)
      | undefined
    expect(typeof toJson).toBe('function')
    expect(typeof extract).toBe('function')
    expect(extract!(toJson!(unixEndpoint))).toEqual(unixEndpoint)
  })

  it('round-trips a stdio-jsonrpc-ndjson endpoint (RED today)', () => {
    const toJson = (brokerRuntimeState as Record<string, unknown>)['toBrokerEndpointJson'] as
      | ((endpoint: unknown) => Record<string, unknown>)
      | undefined
    const extract = (brokerRuntimeState as Record<string, unknown>)['extractBrokerEndpoint'] as
      | ((json: Record<string, unknown> | undefined) => unknown)
      | undefined
    expect(typeof toJson).toBe('function')
    expect(typeof extract).toBe('function')
    expect(extract!(toJson!(stdioEndpoint))).toEqual(stdioEndpoint)
  })
})

describe('T-01810 Phase 1 — durable broker-client interface shape', () => {
  // A client carrying every v1 (BrokerClientLike) method PLUS the five v2
  // durability methods.
  const durableClient = {
    hello: async () => ({}) as never,
    health: async () => ({}) as never,
    startInvocationFromRequest: async () => ({}) as never,
    input: async () => ({}) as never,
    interrupt: async () => ({}) as never,
    stop: async () => ({}) as never,
    status: async () => ({}) as never,
    dispose: async () => undefined,
    onPermissionRequest: () => undefined,
    onClose: () => undefined,
    close: async () => undefined,
    // v2 durability surface:
    attach: async () => ({}) as never,
    snapshot: async () => ({}) as never,
    eventsSince: async () => ({}) as never,
    ackEvents: async () => ({}) as never,
    permissionRespond: async () => ({}) as never,
  }

  // A stdio-only client (BrokerClientLike) missing the v2 durability methods.
  const stdioOnlyClient = {
    hello: async () => ({}) as never,
    health: async () => ({}) as never,
    startInvocationFromRequest: async () => ({}) as never,
    input: async () => ({}) as never,
    interrupt: async () => ({}) as never,
    stop: async () => ({}) as never,
    status: async () => ({}) as never,
    dispose: async () => undefined,
    onPermissionRequest: () => undefined,
    onClose: () => undefined,
    close: async () => undefined,
  }

  it('isDurableBrokerClient accepts a client with attach/snapshot/eventsSince/ackEvents/permissionRespond (RED today)', () => {
    const guard = (brokerController as Record<string, unknown>)['isDurableBrokerClient'] as
      | ((client: unknown) => boolean)
      | undefined
    expect(typeof guard).toBe('function')
    expect(guard!(durableClient)).toBe(true)
  })

  it('isDurableBrokerClient rejects a stdio-only BrokerClientLike (RED today)', () => {
    const guard = (brokerController as Record<string, unknown>)['isDurableBrokerClient'] as
      | ((client: unknown) => boolean)
      | undefined
    expect(typeof guard).toBe('function')
    expect(guard!(stdioOnlyClient)).toBe(false)
  })
})

describe('T-01810 Phase 1 — HRC durable-IPC feature flag', () => {
  const ENV = 'HRC_BROKER_DURABLE_IPC_ENABLED'
  const previous = process.env[ENV]

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[ENV]
    } else {
      process.env[ENV] = previous
    }
  })

  function resolver() {
    return (optionResolvers as Record<string, unknown>)['resolveBrokerDurableIpcEnabled'] as
      | ((options: Record<string, unknown>) => boolean)
      | undefined
  }

  it('is OFF by default when the env var is unset (RED today)', () => {
    delete process.env[ENV]
    const resolve = resolver()
    expect(typeof resolve).toBe('function')
    expect(resolve!({})).toBe(false)
  })

  it('is ON when the env var is truthy (RED today)', () => {
    const resolve = resolver()
    expect(typeof resolve).toBe('function')
    process.env[ENV] = '1'
    expect(resolve!({})).toBe(true)
    process.env[ENV] = 'true'
    expect(resolve!({})).toBe(true)
  })

  it('is OFF when the env var is falsy (RED today)', () => {
    const resolve = resolver()
    expect(typeof resolve).toBe('function')
    process.env[ENV] = '0'
    expect(resolve!({})).toBe(false)
  })

  it('honors an explicit options override over the env var (RED today)', () => {
    const resolve = resolver()
    expect(typeof resolve).toBe('function')
    delete process.env[ENV]
    expect(resolve!({ brokerDurableIpcEnabled: true })).toBe(true)
    process.env[ENV] = '1'
    expect(resolve!({ brokerDurableIpcEnabled: false })).toBe(false)
  })
})

describe('T-01810 Phase 1 — durable-interactive route guard', () => {
  function guard() {
    return (brokerDecisions as Record<string, unknown>)['decideBrokerDurableInteractiveRoute'] as
      | ((input: {
          durableIpcEnabled: boolean
          endpointKind: 'stdio-jsonrpc-ndjson' | 'unix-jsonrpc-ndjson'
          interactionMode: 'interactive' | 'headless'
        }) => string)
      | undefined
  }

  it('selects the durable-ipc route when flag ON and endpoint is unix (RED today)', () => {
    const decide = guard()
    expect(typeof decide).toBe('function')
    expect(
      decide!({ durableIpcEnabled: true, endpointKind: 'unix-jsonrpc-ndjson', interactionMode: 'interactive' })
    ).toBe('durable-ipc')
  })

  it('does NOT select durable-ipc when the flag is OFF, even with a unix endpoint (RED today)', () => {
    const decide = guard()
    expect(typeof decide).toBe('function')
    expect(
      decide!({ durableIpcEnabled: false, endpointKind: 'unix-jsonrpc-ndjson', interactionMode: 'interactive' })
    ).not.toBe('durable-ipc')
  })

  it('does NOT select durable-ipc when the endpoint is stdio, even with the flag ON (RED today)', () => {
    const decide = guard()
    expect(typeof decide).toBe('function')
    expect(
      decide!({ durableIpcEnabled: true, endpointKind: 'stdio-jsonrpc-ndjson', interactionMode: 'interactive' })
    ).not.toBe('durable-ipc')
  })
})
