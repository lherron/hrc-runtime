import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HRC_TASK_CLAIM_CREDENTIAL_FILE_ENV } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { buildHeadlessBrokerDispatchEnv } from '../broker-headless-handlers.js'
import { buildInteractiveBrokerDispatchEnv } from '../broker-interactive-handlers.js'
import { injectRuntimeTaskClaimCredentialFile } from '../federation/task-claim-runtime.js'
import { injectRuntimeWrkqAuthority } from '../federation/wrkq-authority.js'

const WRKQ_AUTHORITY_SOURCE = {
  HRC_WRKQ_DB: 'rpc://canonical.example:7171',
  HRC_WRKQD_TOKEN_FILE: '/run/secrets/wrkq-node-token',
}
const CLAIM_TOKEN = 'claim-secret-never-in-dispatch-env'

describe('T-05562 managed broker wrkq authority', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  for (const [launchPath, buildDispatchEnv] of [
    ['headless', buildHeadlessBrokerDispatchEnv],
    ['interactive', buildInteractiveBrokerDispatchEnv],
  ] as const) {
    for (const claimed of [false, true]) {
      test(`${launchPath} broker projects locator/token authority when ${
        claimed ? 'claimed' : 'unclaimed'
      } and claim authority only when claimed`, async () => {
        const directory = await mkdtemp(join(tmpdir(), `hrc-t05562-${launchPath}-`))
        tempDirs.push(directory)
        const db = openHrcDatabase(join(directory, 'state.sqlite'))
        try {
          const hostSessionId = `hsid-${launchPath}-${claimed ? 'claimed' : 'unclaimed'}`
          const runtimeId = `rt-${launchPath}-${claimed ? 'claimed' : 'unclaimed'}`
          const now = '2026-07-24T22:00:00.000Z'
          db.sessions.insert({
            hostSessionId,
            scopeRef: `agent:cody:project:hrc-runtime:task:${claimed ? 'T-05562' : 'primary'}`,
            laneRef: 'main',
            generation: 1,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            ancestorScopeRefs: [],
          })
          if (claimed) {
            db.sessionTaskClaimAuthorities.insert({
              hostSessionId,
              taskId: 'T-05562',
              claimedBy: 'agent:cody',
              claimedScope: 'agent:cody:project:hrc-runtime:task:T-05562',
              claimedNode: 'svc',
              claimedAt: now,
              claimGeneration: 1,
              claimToken: CLAIM_TOKEN,
              createdAt: now,
            })
          }

          const env = buildDispatchEnv({
            baseEnv: {
              KEEP: 'yes',
              WRKQ_DB: '/tmp/caller-selected.sqlite',
              WRKQ_DB_PATH: '/tmp/stale.sqlite',
              WRKQ_DB_PATH_FILE: '/tmp/stale-path-file',
              WRKQD_TOKEN: 'stale-inline-token',
              [HRC_TASK_CLAIM_CREDENTIAL_FILE_ENV]: '/tmp/stale-claim.json',
            },
            db,
            runtimeRoot: directory,
            hostSessionId,
            runtimeId,
            mailStopSocket: '/run/hrc.sock',
            wrkqAuthoritySource: WRKQ_AUTHORITY_SOURCE,
          })

          expect(env).toMatchObject({
            KEEP: 'yes',
            WRKQ_DB: WRKQ_AUTHORITY_SOURCE.HRC_WRKQ_DB,
            WRKQ_DB_PATH: '',
            WRKQ_DB_PATH_FILE: '',
            WRKQD_TOKEN_FILE: WRKQ_AUTHORITY_SOURCE.HRC_WRKQD_TOKEN_FILE,
            HRC_MAIL_STOP_SOCKET: '/run/hrc.sock',
          })
          expect(env).not.toHaveProperty('WRKQD_TOKEN')
          expect(Object.values(env)).not.toContain('stale-inline-token')
          expect(Object.values(env)).not.toContain(CLAIM_TOKEN)

          const claimCredentialPath = env[HRC_TASK_CLAIM_CREDENTIAL_FILE_ENV]
          if (claimed) {
            expect(claimCredentialPath).toBeString()
            expect((await stat(claimCredentialPath!)).mode & 0o777).toBe(0o600)
            expect(JSON.parse(await readFile(claimCredentialPath!, 'utf8'))).toMatchObject({
              taskId: 'T-05562',
              claimToken: CLAIM_TOKEN,
            })
          } else {
            expect(claimCredentialPath).toBeUndefined()
          }
        } finally {
          db.close()
        }
      })
    }
  }

  test('locator projection and task-claim projection remain independent helpers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hrc-t05562-independent-'))
    tempDirs.push(directory)
    const db = openHrcDatabase(join(directory, 'state.sqlite'))
    try {
      const hostSessionId = 'hsid-independent-unclaimed'
      const now = '2026-07-24T22:00:00.000Z'
      db.sessions.insert({
        hostSessionId,
        scopeRef: 'agent:cody:project:hrc-runtime:task:primary',
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      const reachable = injectRuntimeWrkqAuthority(
        { KEEP: 'yes', WRKQ_DB_PATH: '/tmp/stale.sqlite' },
        WRKQ_AUTHORITY_SOURCE
      )
      expect(reachable).toMatchObject({
        KEEP: 'yes',
        WRKQ_DB: WRKQ_AUTHORITY_SOURCE.HRC_WRKQ_DB,
        WRKQ_DB_PATH: '',
        WRKQ_DB_PATH_FILE: '',
        WRKQD_TOKEN_FILE: WRKQ_AUTHORITY_SOURCE.HRC_WRKQD_TOKEN_FILE,
      })

      const stillUnclaimed = injectRuntimeTaskClaimCredentialFile(reachable, {
        db,
        runtimeRoot: directory,
        hostSessionId,
      })
      expect(stillUnclaimed).toEqual(reachable)
      expect(stillUnclaimed).not.toHaveProperty(HRC_TASK_CLAIM_CREDENTIAL_FILE_ENV)
    } finally {
      db.close()
    }
  })

  test('a local canonical locator still uses WRKQ_DB and clears path aliases', () => {
    expect(
      injectRuntimeWrkqAuthority(
        {
          WRKQ_DB_PATH: '/tmp/stale.sqlite',
          WRKQ_DB_PATH_FILE: '/tmp/stale-path-file',
        },
        { HRC_WRKQ_DB: '/var/lib/praesidium/wrkq.sqlite' }
      )
    ).toEqual({
      WRKQ_DB: '/var/lib/praesidium/wrkq.sqlite',
      WRKQ_DB_PATH: '',
      WRKQ_DB_PATH_FILE: '',
    })
  })
})
