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

const connectAspdUnix: AspdConnect = ({ socketPath, timeoutMs }) =>
  AspcUnixClient.connect({
    socketPath,
    clientInfo: { name: 'hrc-server' },
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

function aspdError(
  code: AspdPreparationErrorCode,
  message: string,
  detail: Record<string, unknown>
): HrcRuntimeUnavailableError {
  return new HrcRuntimeUnavailableError(message, { code, route: 'aspd', ...detail })
}

/** Validate the service hello this route depends on. Returns the identity or throws. */
export function admitAspdHello(endpoint: string, hello: AspcHelloResponse): AspdServiceIdentity {
  if (hello.protocolVersion !== ASPC_PROTOCOL_VERSION) {
    throw aspdError(
      'aspd_protocol_incompatible',
      `aspd negotiated ${String(hello.protocolVersion)}; HRC requires ${ASPC_PROTOCOL_VERSION}`,
      { endpoint, offered: hello.protocolVersion, required: ASPC_PROTOCOL_VERSION }
    )
  }
  const capabilities = hello.capabilities
  const transports = (capabilities?.transports ?? []) as readonly string[]
  if (
    capabilities?.compileHarnessInvocation !== true ||
    !transports.includes('unix-jsonrpc-ndjson')
  ) {
    throw aspdError(
      'aspd_capability_missing',
      'aspd does not offer unix compileHarnessInvocation',
      {
        endpoint,
        required: { compileHarnessInvocation: true, transport: 'unix-jsonrpc-ndjson' },
        offered: { compileHarnessInvocation: capabilities?.compileHarnessInvocation, transports },
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

/** Bounded hello probe for status readback. Closes its connection. */
export async function probeAspdService(
  endpoint: string,
  connect: AspdConnect = connectAspdUnix
): Promise<AspdServiceIdentity> {
  let client: AspdClientLike
  try {
    client = await connect({ socketPath: endpoint, timeoutMs: 1_000 })
  } catch (error) {
    throw translateAspdError(endpoint, error)
  }
  try {
    return admitAspdHello(endpoint, client.hello)
  } finally {
    await client.close().catch(() => undefined)
  }
}

function translateAspdError(endpoint: string, error: unknown): unknown {
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
