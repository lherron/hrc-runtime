import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FEDERATION_CONFIG_BASENAME } from '../../federation/federation-config.js'

export type FederationConfigFixture = {
  stateRoot: string
  configPath: string
  env: NodeJS.ProcessEnv
}

/**
 * Runs `fn` against a temp state root containing a federation config file.
 *
 * Pass a string to write malformed content verbatim; pass an object to write it
 * as JSON. Pass `undefined` for the absent-file (single-node) case.
 */
export async function withFederationConfigFile<T>(
  content: unknown | string | undefined,
  fn: (fixture: FederationConfigFixture) => Promise<T>,
  options: { mode?: number } = {}
): Promise<T> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'hrc-federation-'))
  const configPath = join(stateRoot, FEDERATION_CONFIG_BASENAME)
  try {
    if (content !== undefined) {
      const raw = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
      await writeFile(configPath, raw, { mode: options.mode ?? 0o600 })
    }
    // Empty env: these tests must not inherit an operator's real
    // HRC_PEER_CONFIG_FILE from the ambient environment.
    return await fn({ stateRoot, configPath, env: {} })
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
}
