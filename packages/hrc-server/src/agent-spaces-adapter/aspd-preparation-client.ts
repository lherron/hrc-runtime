/**
 * The aspd preparation hop for the HRC-hosted headless codex-app-server route
 * (T-08542; docs/aspd-headless-codex-integration.md).
 *
 * One Unix connection per preparation: connect, negotiate `aspc.hello`, run the
 * existing `aspc.compileHarnessInvocation`, close. HRC holds no resident
 * compiler connection, so aspd activation can never be pinned by HRC. Nothing
 * here retries, falls back to the bundled facade, or resolves an ASP binary:
 * every failure is a named `HrcRuntimeUnavailableError` raised before any
 * hosting effect.
 */
import { isAbsolute } from 'node:path'

import { HrcRuntimeUnavailableError } from 'hrc-core'
import type { HrcAspdServiceStatus } from 'hrc-core'
import {
  ASPC_PROTOCOL_VERSION,
  type AspcCompileHarnessInvocationRequest,
  type AspcCompileHarnessInvocationResponse,
  type AspcHelloResponse,
} from 'spaces-aspc-protocol'
import {
  AspcConnectionClosedError,
  AspcProtocolIncompatibleError,
  AspcRequestTimeoutError,
  AspcServiceUnavailableError,
  AspcUnixClient,
} from 'spaces-aspc-protocol/unix-client'
import type { AspReleaseIdentity } from 'spaces-harness-broker-protocol'

export const HRC_ASPD_SOCKET_ENV = 'HRC_ASPD_SOCKET'

export type AspdPreparationErrorCode =
  | 'aspd_endpoint_invalid'
  | 'aspd_unavailable'
  | 'aspd_protocol_incompatible'
  | 'aspd_capability_missing'
  | 'aspd_release_unidentified'
  | 'aspd_connection_closed'
  | 'aspd_request_timeout'

export type AspdServiceIdentity = {
  endpoint: string
  protocolVersion: string
  release: AspReleaseIdentity
  serviceInfo: AspcHelloResponse['facadeInfo']
}

export type AspdPreparationResult = {
  service: AspdServiceIdentity
  response: AspcCompileHarnessInvocationResponse
}

export type AspdClientLike = {
  readonly hello: AspcHelloResponse
  compileHarnessInvocation(
    req: AspcCompileHarnessInvocationRequest
  ): Promise<AspcCompileHarnessInvocationResponse>
  close(): Promise<void>
}

export type AspdConnect = (options: {
  socketPath: string
  timeoutMs?: number | undefined
}) => Promise<AspdClientLike>

/**
 * Every request after hello is bounded too: an aspd that accepts and never
 * answers otherwise holds a birth open forever (R-00277). Generous, because a
 * compile is real work; the bound exists to end a hang, not to pace aspd.
 */
export const ASPD_PREPARATION_REQUEST_TIMEOUT_MS = 120_000

export const connectAspdUnix: AspdConnect = ({ socketPath, timeoutMs }) =>
  AspcUnixClient.connect({
    socketPath,
    clientInfo: { name: 'hrc-server' },
    requestTimeoutMs: ASPD_PREPARATION_REQUEST_TIMEOUT_MS,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })

/**
 * The configured endpoint, or undefined when this node has none. Read on every
 * call; a present-but-unusable value is an error, never "unset".
 */
export function configuredAspdEndpoint(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const raw = env[HRC_ASPD_SOCKET_ENV]
  if (raw === undefined) return undefined
  const value = raw.trim()
  if (value.length === 0 || !isAbsolute(value)) {
    throw aspdError('aspd_endpoint_invalid', `${HRC_ASPD_SOCKET_ENV} must be an absolute path`, {
      endpoint: raw,
    })
  }
  return value
}

export function aspdError(
  code: AspdPreparationErrorCode,
  message: string,
  detail: Record<string, unknown>
): HrcRuntimeUnavailableError {
  return new HrcRuntimeUnavailableError(message, { code, route: 'aspd', ...detail })
}

/**
 * Validate the service hello a route depends on. Returns the identity or throws.
 * T-08564: `requiredCapabilities` names the operations the caller will invoke on
 * this connection; the default is the preparation route's single operation, so
 * existing callers keep their exact refusal detail.
 */
export function admitAspdHello(
  endpoint: string,
  hello: AspcHelloResponse,
  requiredCapabilities: readonly string[] = ['compileHarnessInvocation']
): AspdServiceIdentity {
  if (hello.protocolVersion !== ASPC_PROTOCOL_VERSION) {
    throw aspdError(
      'aspd_protocol_incompatible',
      `aspd negotiated ${String(hello.protocolVersion)}; HRC requires ${ASPC_PROTOCOL_VERSION}`,
      { endpoint, offered: hello.protocolVersion, required: ASPC_PROTOCOL_VERSION }
    )
  }
  const capabilities = hello.capabilities as Record<string, unknown> | undefined
  const transports = (capabilities?.['transports'] ?? []) as readonly string[]
  const missing = requiredCapabilities.filter((name) => capabilities?.[name] !== true)
  if (missing.length > 0 || !transports.includes('unix-jsonrpc-ndjson')) {
    throw aspdError(
      'aspd_capability_missing',
      `aspd does not offer unix ${requiredCapabilities.join(', ')}`,
      {
        endpoint,
        required: {
          ...Object.fromEntries(requiredCapabilities.map((name) => [name, true])),
          transport: 'unix-jsonrpc-ndjson',
        },
        offered: {
          ...Object.fromEntries(requiredCapabilities.map((name) => [name, capabilities?.[name]])),
          transports,
        },
      }
    )
  }
  const release = hello.release
  if (
    release === undefined ||
    typeof release.releaseId !== 'string' ||
    typeof release.sourceCommit !== 'string' ||
    typeof release.builtAt !== 'string'
  ) {
    throw aspdError('aspd_release_unidentified', 'aspd hello carries no release identity', {
      endpoint,
    })
  }
  return {
    endpoint,
    protocolVersion: hello.protocolVersion,
    release: {
      releaseId: release.releaseId,
      sourceCommit: release.sourceCommit,
      builtAt: release.builtAt,
    },
    serviceInfo: hello.facadeInfo,
  }
}

/** Connect, negotiate, compile once, close. Never retries. */
export async function prepareThroughAspd(
  endpoint: string,
  request: AspcCompileHarnessInvocationRequest,
  connect: AspdConnect = connectAspdUnix
): Promise<AspdPreparationResult> {
  let client: AspdClientLike
  try {
    client = await connect({ socketPath: endpoint })
  } catch (error) {
    throw translateAspdError(endpoint, error)
  }
  try {
    const service = admitAspdHello(endpoint, client.hello)
    const response = await client.compileHarnessInvocation(request)
    return { service, response }
  } catch (error) {
    throw translateAspdError(endpoint, error)
  } finally {
    await client.close().catch(() => undefined)
  }
}

/**
 * The whole status probe, connect AND hello: the client bounds both under one
 * deadline. An aspd that accepted and never answered hello used to hang
 * /v1/status, `hrc doctor` and the deploy preflight with it (R-00277).
 */
const ASPD_PROBE_TIMEOUT_MS = 2_000

/** Bounded hello probe for status readback. Closes its connection. */
export async function probeAspdService(
  endpoint: string,
  connect: AspdConnect = connectAspdUnix
): Promise<AspdServiceIdentity> {
  let client: AspdClientLike
  try {
    client = await connect({ socketPath: endpoint, timeoutMs: ASPD_PROBE_TIMEOUT_MS })
  } catch (error) {
    throw translateAspdError(endpoint, error)
  }
  try {
    return admitAspdHello(endpoint, client.hello)
  } finally {
    await client.close().catch(() => undefined)
  }
}

export function translateAspdError(endpoint: string, error: unknown): unknown {
  if (error instanceof HrcRuntimeUnavailableError) return error
  if (error instanceof AspcServiceUnavailableError) {
    return aspdError('aspd_unavailable', `aspd unavailable at ${endpoint}`, {
      endpoint,
      cause: describe(error.causeError),
    })
  }
  if (error instanceof AspcProtocolIncompatibleError) {
    return aspdError(
      'aspd_protocol_incompatible',
      `aspd negotiated ${error.offered}; HRC requires ${ASPC_PROTOCOL_VERSION}`,
      { endpoint, offered: error.offered, required: ASPC_PROTOCOL_VERSION }
    )
  }
  if (error instanceof AspcRequestTimeoutError) {
    return aspdError(
      'aspd_request_timeout',
      `aspd at ${endpoint} did not answer ${error.method} within ${error.timeoutMs}ms`,
      { endpoint, method: error.method, timeoutMs: error.timeoutMs }
    )
  }
  if (error instanceof AspcConnectionClosedError) {
    return aspdError('aspd_connection_closed', error.message, {
      endpoint,
      method: error.method,
      retried: false,
    })
  }
  return error
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Status projection of the configured aspd service. Never throws. */
export async function projectAspdServiceStatus(
  env: Record<string, string | undefined> = process.env,
  connect: AspdConnect = connectAspdUnix
): Promise<HrcAspdServiceStatus> {
  const probedAt = new Date().toISOString()
  let endpoint: string | undefined
  try {
    endpoint = configuredAspdEndpoint(env)
  } catch (error) {
    return {
      configured: true,
      endpoint: env[HRC_ASPD_SOCKET_ENV],
      reachable: false,
      error: errorSummary(error),
      probedAt,
    }
  }
  if (endpoint === undefined) return { configured: false }
  try {
    const service = await probeAspdService(endpoint, connect)
    return {
      configured: true,
      endpoint,
      reachable: true,
      protocolVersion: service.protocolVersion,
      release: service.release,
      probedAt,
    }
  } catch (error) {
    return { configured: true, endpoint, reachable: false, error: errorSummary(error), probedAt }
  }
}

function errorSummary(error: unknown): { code: string; message: string } {
  const detail = (error as { detail?: { code?: unknown } }).detail
  return {
    code: typeof detail?.code === 'string' ? detail.code : 'aspd_probe_failed',
    message: error instanceof Error ? error.message : String(error),
  }
}
