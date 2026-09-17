/**
 * T-08564 Phase A: the daemon's single door to ASP declaration observations.
 *
 * One Unix connection per observation request: connect, admit `aspc.hello` for
 * every operation the caller will run on this connection, run them, close. The
 * CLI and SDK never dial aspd; they reach this adapter through daemon routes.
 * Nothing here retries, caches, or falls back to in-process interpretation: an
 * unconfigured or unreachable aspd is a typed `runtime_unavailable` error.
 */
import { AspcUnixClient } from 'spaces-aspc-protocol/unix-client'

import {
  type AspdServiceIdentity,
  admitAspdHello,
  aspdError,
  configuredAspdEndpoint,
  translateAspdError,
} from './aspd-preparation-client.js'

export type AspdObservationOperation =
  | 'resolveRuntimeDeclaration'
  | 'inspectRuntimePlacement'
  | 'compileHarnessInvocation'
  | 'inspectRuntimePlacementPreparationCorrelation'

export type AspdObservationClient = Pick<
  AspcUnixClient,
  'resolveRuntimeDeclaration' | 'inspectRuntimePlacement' | 'compileHarnessInvocation' | 'close'
> & { readonly hello: AspcUnixClient['hello'] }

export type AspdObservationConnect = (options: {
  socketPath: string
}) => Promise<AspdObservationClient>

const connectObservationUnix: AspdObservationConnect = ({ socketPath }) =>
  AspcUnixClient.connect({ socketPath, clientInfo: { name: 'hrc-server' } })

export type AspdObservationSession = {
  service: AspdServiceIdentity
  client: AspdObservationClient
}

/**
 * Open one admitted connection, run `work` on it, and always close it. Every
 * failure — endpoint, connection, hello admission, or a transport fault during
 * `work` — surfaces as the named aspd error, never as absence.
 */
export async function withAspdObservationSession<T>(
  operations: readonly AspdObservationOperation[],
  work: (session: AspdObservationSession) => Promise<T>,
  env: Record<string, string | undefined> = process.env,
  connect: AspdObservationConnect = connectObservationUnix
): Promise<T> {
  const endpoint = configuredAspdEndpoint(env)
  if (endpoint === undefined) {
    throw aspdError('aspd_unavailable', 'aspd is not configured on this node', {
      endpoint: null,
      operations,
    })
  }
  let client: AspdObservationClient
  try {
    client = await connect({ socketPath: endpoint })
  } catch (error) {
    throw translateAspdError(endpoint, error)
  }
  try {
    const service = admitAspdHello(endpoint, client.hello, operations)
    return await work({ service, client })
  } catch (error) {
    throw translateAspdError(endpoint, error)
  } finally {
    await client.close().catch(() => undefined)
  }
}
