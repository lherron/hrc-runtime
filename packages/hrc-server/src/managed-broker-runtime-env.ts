import { injectRuntimeWrkqAuthority } from './federation/wrkq-authority.js'

export type ManagedBrokerDispatchEnvInput = {
  baseEnv: Record<string, string>
  mailStopSocket: string
  wrkqAuthoritySource?: Record<string, string | undefined> | undefined
}

/**
 * Build the daemon-owned portion of a broker launch environment: every managed
 * runtime receives host wrkq locator/token-file authority and the mail stop
 * socket.
 */
export function buildManagedBrokerDispatchEnv(
  input: ManagedBrokerDispatchEnvInput
): Record<string, string> {
  return {
    ...injectRuntimeWrkqAuthority(input.baseEnv, input.wrkqAuthoritySource),
    HRC_MAIL_STOP_SOCKET: input.mailStopSocket,
  }
}
