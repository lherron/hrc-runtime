import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import { CORRUPT_SPOOL_DIRNAME, readSpoolEntries } from './launch/index.js'
import { isRecord } from './server-parsers.js'
import type { HrcServerOptions } from './server-types.js'
import { logStartupIssue } from './startup-reconcile.js'

/**
 * Endpoints of the retired launch-wrapper ingest (T-08566 stage 1). A spooled
 * entry for one of them is never applied: it is moved to the corrupt-spool
 * quarantine so its bytes stay inspectable, and startup logs it by name.
 */
function isRetiredLaunchIngestEndpoint(endpoint: string): boolean {
  return endpoint === '/v1/internal/hooks/ingest' || endpoint.startsWith('/v1/internal/launches/')
}

export async function replaySpool(options: HrcServerOptions): Promise<void> {
  let launchIds: string[]
  try {
    launchIds = (await readdir(options.spoolDir)).sort()
  } catch {
    return
  }

  for (const launchId of launchIds) {
    if (launchId === CORRUPT_SPOOL_DIRNAME) {
      continue
    }
    const launchDir = join(options.spoolDir, launchId)
    const launchDirStat = await stat(launchDir).catch(() => null)
    if (!launchDirStat?.isDirectory()) {
      continue
    }

    const entries = await readSpoolEntries(options.spoolDir, launchId, {
      onCorruptEntry: (entry) => {
        logStartupIssue(
          'corrupt spool entry quarantined',
          {
            launchId,
            path: entry.path,
            quarantinePath: entry.quarantinePath,
            ...(entry.quarantineError ? { quarantineError: entry.quarantineError } : {}),
          },
          entry.error
        )
      },
    })
    let hadFailure = false
    for (const entry of entries) {
      try {
        const endpoint = spoolEntryEndpoint(entry.payload)
        if (isRetiredLaunchIngestEndpoint(endpoint)) {
          const quarantineDir = join(options.spoolDir, CORRUPT_SPOOL_DIRNAME, launchId)
          await mkdir(quarantineDir, { recursive: true })
          const quarantinePath = join(
            quarantineDir,
            `${basename(entry.path)}.retired-${randomUUID()}`
          )
          await rename(entry.path, quarantinePath)
          logStartupIssue(
            'retired legacy spool entry quarantined',
            {
              launchId,
              endpoint,
              path: entry.path,
              quarantinePath,
            },
            undefined
          )
          continue
        }
        throw new HrcBadRequestError(
          HrcErrorCode.MALFORMED_REQUEST,
          `unsupported spool endpoint "${endpoint}"`,
          { endpoint }
        )
      } catch (error) {
        hadFailure = true
        logStartupIssue('spool replay failed', { launchId, path: entry.path }, error)
      }
    }

    if (!hadFailure) {
      await rm(launchDir, { recursive: true, force: true })
    }
  }
}

function spoolEntryEndpoint(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'spool entry must be an object')
  }
  const endpoint = payload['endpoint']
  if (typeof endpoint !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'spool entry endpoint must be a string'
    )
  }
  return endpoint
}
